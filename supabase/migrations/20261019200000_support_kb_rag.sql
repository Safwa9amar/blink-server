-- Support-bot RAG: hybrid (pgvector + keyword) retrieval over the support KB.
-- (Drizzle: src/db/schema/support-kb-chunks.ts, src/db/schema/ai-settings.ts)
--
-- Why: runBotTurn used to stuff EVERY published support_articles row into the
-- system prompt (~27k tokens per turn). With `ai_settings.rag_enabled` on, the
-- server instead retrieves only the top-k chunks relevant to the user's latest
-- question.
--
-- * support_kb_chunks: one row per (article, locale, chunk). The embedding column
--   is an UNTYPED `vector` (no fixed dimension) so the embedding model can be
--   changed from the dashboard; rows are tagged with `embedding_model` and
--   match_support_kb only considers rows of the model being queried. No ANN index:
--   ~1k rows, an exact scan is fast and works with untyped dimensions.
-- * `fts` is a generated tsvector ('simple' config — the KB is en/fr/ar) used for
--   the keyword half of the hybrid search.
-- * match_support_kb fuses semantic + keyword ranks with Reciprocal Rank Fusion.
--   The keyword query is an OR of the question's words, so it's noisy: in hybrid
--   mode its rank counts half, so a weak word overlap can't outrank a strong
--   semantic match. Keyword-only (no query embedding) counts in full.
-- * Service-role only: RLS on, no policies; EXECUTE revoked from anon/authenticated.
-- Additive only. The index is (re)built by the server (lib/support-kb-index.ts).

create extension if not exists vector with schema extensions;

alter table public.ai_settings
  add column if not exists rag_enabled boolean not null default false,
  add column if not exists embedding_provider text not null default 'openrouter',
  add column if not exists embedding_model text,
  add column if not exists rag_top_k integer not null default 6,
  add column if not exists rag_min_score real not null default 0.3;

create table if not exists public.support_kb_chunks (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.support_articles(id) on delete cascade,
  locale text not null check (locale in ('en', 'fr', 'ar')),
  chunk_index integer not null,
  title text not null,
  content text not null,
  content_hash text not null,
  source_updated_at timestamptz not null,
  embedding extensions.vector,
  embedding_model text not null,
  fts tsvector generated always as (to_tsvector('simple', title || ' ' || content)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (article_id, locale, chunk_index)
);

create index if not exists idx_support_kb_chunks_article on public.support_kb_chunks (article_id);
create index if not exists idx_support_kb_chunks_fts on public.support_kb_chunks using gin (fts);

drop trigger if exists support_kb_chunks_updated_at on public.support_kb_chunks;
create trigger support_kb_chunks_updated_at
  before update on public.support_kb_chunks
  for each row execute function update_updated_at();

alter table public.support_kb_chunks enable row level security;

create or replace function public.match_support_kb(
  query_embedding extensions.vector,
  keyword_query text,
  role_label text,
  embed_model text,
  match_count int,
  min_score real
)
returns table (
  chunk_id uuid,
  article_id uuid,
  locale text,
  type text,
  title text,
  content text,
  similarity real,
  keyword_rank real,
  score real
)
language sql
stable
set search_path = public, extensions
as $$
  with eligible as (
    select c.id, c.article_id, c.locale, a.type::text as type, c.title, c.content,
           c.embedding, c.fts
    from public.support_kb_chunks c
    join public.support_articles a on a.id = c.article_id
    where a.status = 'published'
      and a.target_roles && array['All', role_label]
      and c.embedding_model = embed_model
  ),
  sem as (
    select id,
           (1 - (embedding <=> query_embedding))::real as similarity,
           row_number() over (order by embedding <=> query_embedding) as rnk
    from (
      select id, embedding
      from eligible
      where query_embedding is not null and embedding is not null
      order by embedding <=> query_embedding
      limit match_count * 4
    ) s
    where (1 - (embedding <=> query_embedding)) >= min_score
  ),
  kw as (
    select id,
           ts_rank_cd(fts, to_tsquery('simple', keyword_query))::real as kw_rank,
           row_number() over (order by ts_rank_cd(fts, to_tsquery('simple', keyword_query)) desc) as rnk
    from (
      select id, fts
      from eligible
      where coalesce(keyword_query, '') <> ''
        and fts @@ to_tsquery('simple', keyword_query)
      order by ts_rank_cd(fts, to_tsquery('simple', keyword_query)) desc
      limit match_count * 4
    ) k
  )
  select e.id as chunk_id, e.article_id, e.locale, e.type, e.title, e.content,
         coalesce(sem.similarity, 0)::real as similarity,
         coalesce(kw.kw_rank, 0)::real as keyword_rank,
         (coalesce(1.0 / (60 + sem.rnk), 0)
          + coalesce(1.0 / (60 + kw.rnk), 0)
            * (case when query_embedding is null then 1.0 else 0.5 end))::real as score
  from sem
  full outer join kw on kw.id = sem.id
  join eligible e on e.id = coalesce(sem.id, kw.id)
  order by score desc
  limit match_count * 3;
$$;

revoke all on function public.match_support_kb(extensions.vector, text, text, text, int, real) from public, anon, authenticated;
grant execute on function public.match_support_kb(extensions.vector, text, text, text, int, real) to service_role;
