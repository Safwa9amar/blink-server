// Support-KB RAG indexer: chunks published support_articles per locale, embeds
// the new/changed chunks and upserts them into support_kb_chunks. Runs in the
// background (never inside a user's chat turn) and is single-flight per process.

import { createHash } from "node:crypto";
import { supabaseAdmin } from "./supabase";
import {
  getAiConfig,
  buildEmbeddingProvider,
  resolveEmbeddingModel,
  type AiConfig,
} from "./ai-settings";
import { chunkArticle, type KbChunk } from "./support-kb-text";

export { chunkArticle } from "./support-kb-text";

const LOCALES = [
  { locale: "en", col: "content_eng" },
  { locale: "fr", col: "content_fr" },
  { locale: "ar", col: "content_ar" },
] as const;

const PAGE = 1000;
const FRESH_CHECK_MS = 30_000;

/** Page through a PostgREST query (default max-rows is 1000). */
async function fetchAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const vecLiteral = (v: number[]) => `[${v.join(",")}]`;
const sameInstant = (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime();

interface ArticleRow {
  id: string;
  type: string;
  updated_at: string;
  content_eng: { title?: string; body?: string } | null;
  content_fr: { title?: string; body?: string } | null;
  content_ar: { title?: string; body?: string } | null;
}

interface ExistingRow {
  id: string;
  article_id: string;
  locale: string;
  chunk_index: number;
  content_hash: string;
  source_updated_at: string;
}

export interface SyncResult {
  embedded: number;
  unchanged: number;
  deleted: number;
  chunks: number;
}

interface IndexState {
  syncing: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  lastSignature: string | null;
}
const state: IndexState = { syncing: false, lastSyncedAt: null, lastError: null, lastSignature: null };
let running: Promise<SyncResult> | null = null;

async function publishedSignature(cfg: AiConfig, model: string): Promise<string> {
  const { data, count, error } = await supabaseAdmin
    .from("support_articles")
    .select("updated_at", { count: "exact" })
    .eq("status", "published")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  return `${count ?? 0}|${data?.[0]?.updated_at ?? ""}|${cfg.embeddingProvider}|${model}`;
}

async function doSync(full: boolean): Promise<SyncResult> {
  const cfg = await getAiConfig({ fresh: true });
  const provider = await buildEmbeddingProvider(cfg);
  if (!provider.embed) throw new Error(`Provider ${provider.name} does not support embeddings`);
  const model = await resolveEmbeddingModel(cfg, provider);
  const signature = await publishedSignature(cfg, model);

  const articles = await fetchAll<ArticleRow>((from, to) =>
    supabaseAdmin
      .from("support_articles")
      .select("id, type, updated_at, content_eng, content_fr, content_ar")
      .eq("status", "published")
      .order("id")
      .range(from, to)
  );
  const existing = await fetchAll<ExistingRow>((from, to) =>
    supabaseAdmin
      .from("support_kb_chunks")
      .select("id, article_id, locale, chunk_index, content_hash, source_updated_at")
      .order("id")
      .range(from, to)
  );

  const existingByKey = new Map(
    existing.map((r) => [`${r.article_id}|${r.locale}|${r.chunk_index}`, r])
  );
  const keep = new Set<string>();

  interface Pending {
    article: ArticleRow;
    locale: string;
    index: number;
    chunk: KbChunk;
    hash: string;
  }
  const toEmbed: Pending[] = [];
  const touchSource = new Set<string>(); // article ids whose unchanged chunks need source_updated_at bumped
  let unchanged = 0;
  let total = 0;

  for (const a of articles) {
    for (const { locale, col } of LOCALES) {
      const c = a[col];
      if (!c?.title?.trim()) continue;
      const chunks = chunkArticle({ type: a.type, title: c.title, html: c.body ?? "" });
      chunks.forEach((chunk, index) => {
        total++;
        const key = `${a.id}|${locale}|${index}`;
        keep.add(key);
        const hash = sha256(`${model}\n${chunk.title}\n${chunk.content}`);
        const ex = existingByKey.get(key);
        if (!full && ex && ex.content_hash === hash) {
          unchanged++;
          if (!sameInstant(ex.source_updated_at, a.updated_at)) touchSource.add(a.id);
        } else {
          toEmbed.push({ article: a, locale, index, chunk, hash });
        }
      });
    }
  }

  // Embed new/changed chunks in batches and upsert.
  const BATCH = 32;
  for (let i = 0; i < toEmbed.length; i += BATCH) {
    const slice = toEmbed.slice(i, i + BATCH);
    const res = await provider.embed(
      slice.map((p) => `${p.chunk.title}\n\n${p.chunk.content}`),
      { model }
    );
    const rows = slice.map((p, j) => ({
      article_id: p.article.id,
      locale: p.locale,
      chunk_index: p.index,
      title: p.chunk.title,
      content: p.chunk.content,
      content_hash: p.hash,
      source_updated_at: p.article.updated_at,
      embedding: vecLiteral(res.embeddings[j]),
      embedding_model: model,
    }));
    const { error } = await supabaseAdmin
      .from("support_kb_chunks")
      .upsert(rows, { onConflict: "article_id,locale,chunk_index" });
    if (error) throw new Error(`upsert failed: ${error.message}`);
  }

  // Unchanged chunks whose article was edited (e.g. another locale): bump the
  // freshness marker without re-embedding.
  for (const id of touchSource) {
    const a = articles.find((x) => x.id === id)!;
    await supabaseAdmin.from("support_kb_chunks").update({ source_updated_at: a.updated_at }).eq("article_id", id);
  }

  // Delete stale rows: surplus chunk indexes, dropped locales, unpublished articles.
  const stale = existing.filter((r) => !keep.has(`${r.article_id}|${r.locale}|${r.chunk_index}`)).map((r) => r.id);
  for (let i = 0; i < stale.length; i += 200) {
    const { error } = await supabaseAdmin.from("support_kb_chunks").delete().in("id", stale.slice(i, i + 200));
    if (error) throw new Error(`delete failed: ${error.message}`);
  }

  state.lastSignature = signature;
  return { embedded: toEmbed.length, unchanged, deleted: stale.length, chunks: total };
}

// Set when a sync is requested while one is running: that run's article snapshot
// may predate the edit that triggered the request, so one more pass follows it.
let rerun: { full: boolean } | null = null;

/** Sync the KB index. Concurrent callers share the in-flight run. */
export function syncKbIndex(opts: { full?: boolean } = {}): Promise<SyncResult> {
  if (running) {
    rerun = { full: (rerun?.full ?? false) || !!opts.full };
    return running;
  }
  state.syncing = true;
  running = doSync(!!opts.full)
    .then((r) => {
      state.lastError = null;
      state.lastSyncedAt = new Date().toISOString();
      return r;
    })
    .catch((e) => {
      state.lastError = (e as Error).message;
      console.error("[kb-index] sync failed", state.lastError);
      throw e;
    })
    .finally(() => {
      state.syncing = false;
      running = null;
      if (rerun) {
        const next = rerun;
        rerun = null;
        void syncKbIndex(next).catch(() => undefined); // errors land in lastError
      }
    });
  return running;
}

export function isKbSyncing(): boolean {
  return state.syncing;
}

let lastCheckAt = 0;
/**
 * Cheap freshness check (at most every 30s): when the published-article
 * signature or embedding model changed since the last sync, start a BACKGROUND
 * sync. Never awaited by the chat turn; all errors are recorded, not thrown.
 */
export function ensureKbIndexFresh(cfg: AiConfig): void {
  const now = Date.now();
  if (state.syncing || now - lastCheckAt < FRESH_CHECK_MS) return;
  lastCheckAt = now;
  void (async () => {
    try {
      const model = await resolveEmbeddingModel(cfg);
      const sig = await publishedSignature(cfg, model);
      if (sig !== state.lastSignature) await syncKbIndex();
    } catch (e) {
      state.lastError = (e as Error).message;
    }
  })();
}

/** DB-derived index status (instance-independent) + this process's sync flags. */
export async function getKbIndexStatus(cfg: AiConfig) {
  const model = await resolveEmbeddingModel(cfg);
  const articles = await fetchAll<{ id: string; updated_at: string }>((from, to) =>
    supabaseAdmin.from("support_articles").select("id, updated_at").eq("status", "published").order("id").range(from, to)
  );
  const chunks = await fetchAll<{ article_id: string; locale: string; source_updated_at: string }>((from, to) =>
    supabaseAdmin
      .from("support_kb_chunks")
      .select("article_id, locale, source_updated_at")
      .eq("embedding_model", model)
      .order("id")
      .range(from, to)
  );
  const byArticle = new Map<string, string[]>();
  const byLocale = { en: 0, fr: 0, ar: 0 } as Record<string, number>;
  for (const c of chunks) {
    byLocale[c.locale] = (byLocale[c.locale] ?? 0) + 1;
    const l = byArticle.get(c.article_id) ?? [];
    l.push(c.source_updated_at);
    byArticle.set(c.article_id, l);
  }
  let indexed = 0;
  let staleCount = 0;
  const published = new Set(articles.map((a) => a.id));
  for (const a of articles) {
    const marks = byArticle.get(a.id);
    if (!marks?.length) {
      staleCount++;
      continue;
    }
    indexed++;
    if (marks.some((m) => !sameInstant(m, a.updated_at))) staleCount++;
  }
  const chunksIndexed = chunks.filter((c) => published.has(c.article_id)).length;
  return {
    rag_enabled: cfg.ragEnabled,
    embedding_provider: cfg.embeddingProvider,
    embedding_model: model,
    articles_published: articles.length,
    articles_indexed: indexed,
    chunks_indexed: chunksIndexed,
    chunks_by_locale: { en: byLocale.en ?? 0, fr: byLocale.fr ?? 0, ar: byLocale.ar ?? 0 },
    stale_articles: staleCount,
    syncing: state.syncing,
    last_synced_at: state.lastSyncedAt,
    last_error: state.lastError,
  };
}
