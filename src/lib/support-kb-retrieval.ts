// Hybrid retrieval over support_kb_chunks (pgvector similarity + keyword FTS,
// fused with RRF in the match_support_kb SQL function).

import { supabaseAdmin } from "./supabase";
import { buildEmbeddingProvider, resolveEmbeddingModel, type AiConfig } from "./ai-settings";
import { ROLE_LABEL, buildKeywordQuery } from "./support-kb-text";

export { buildRetrievalQuery } from "./support-kb-text";

export interface KbResult {
  article_id: string;
  chunk_id: string;
  title: string;
  locale: string;
  type: string;
  content: string;
  similarity: number;
  keyword_rank: number;
  score: number;
}

export interface KbRetrieval {
  mode: "hybrid" | "keyword" | "empty";
  results: KbResult[];
  text: string;
}

const HEADER =
  "(Knowledge-base excerpts most relevant to the user's latest question, best match first. If they don't cover the question, follow the escalation rules.)";

// Tiny LRU of recent query embeddings (key = model + text).
const CACHE_MAX = 200;
const embedCache = new Map<string, number[]>();
function cacheGet(k: string): number[] | undefined {
  const v = embedCache.get(k);
  if (v) {
    embedCache.delete(k);
    embedCache.set(k, v);
  }
  return v;
}
function cacheSet(k: string, v: number[]) {
  embedCache.set(k, v);
  if (embedCache.size > CACHE_MAX) embedCache.delete(embedCache.keys().next().value as string);
}

/**
 * The language version to show: Arabic script in the question → "ar"; a Latin
 * question in an Arabic-locale conversation is ambiguous (French? English?
 * Arabizi?) → none, best score wins; otherwise the conversation locale.
 */
export function preferredLocale(query: string, locale: string): string | null {
  if (/[؀-ۿ]/.test(query)) return "ar";
  if (locale === "ar") return null;
  return locale === "fr" ? "fr" : "en";
}

/** Format picked results as the prompt's KB text, grouped by article in score order. */
export function formatKbText(results: KbResult[]): string {
  if (!results.length) return "";
  const order: string[] = [];
  const groups = new Map<string, KbResult[]>();
  for (const r of results) {
    if (!groups.has(r.article_id)) {
      groups.set(r.article_id, []);
      order.push(r.article_id);
    }
    groups.get(r.article_id)!.push(r);
  }
  const blocks = order.flatMap((id) =>
    groups.get(id)!.map((r) => (r.type === "faq" ? `Q: ${r.title}\nA: ${r.content}` : `### ${r.title}\n${r.content}`))
  );
  return `${HEADER}\n\n${blocks.join("\n\n")}`;
}

export async function retrieveKb(opts: {
  role: string;
  locale: string;
  query: string;
  cfg: AiConfig;
  topK?: number;
  minScore?: number;
}): Promise<KbRetrieval> {
  const { cfg } = opts;
  const topK = Math.min(20, Math.max(1, opts.topK ?? cfg.ragTopK));
  const minScore = Math.min(1, Math.max(0, opts.minScore ?? cfg.ragMinScore));
  const query = opts.query.trim();
  if (!query) return { mode: "empty", results: [], text: "" };

  const provider = await buildEmbeddingProvider(cfg);
  const model = await resolveEmbeddingModel(cfg, provider);

  let embedding: number[] | null = null;
  try {
    if (!provider.embed) throw new Error("no embed support");
    const key = `${cfg.embeddingProvider}|${model}|${query}`;
    embedding = cacheGet(key) ?? null;
    if (!embedding) {
      // A user is waiting on this turn: fail fast (no retry) and fall back,
      // rather than inherit the indexer's 60s timeout.
      const res = await provider.embed([query], { model, timeoutMs: 5000, maxRetries: 0 });
      embedding = res.embeddings[0] ?? null;
      if (embedding) cacheSet(key, embedding);
    }
  } catch (e) {
    console.error("[kb-retrieval] embed failed, keyword-only:", (e as Error).message);
    embedding = null;
  }

  const { data, error } = await supabaseAdmin.rpc("match_support_kb", {
    query_embedding: embedding ? `[${embedding.join(",")}]` : null,
    keyword_query: buildKeywordQuery(query),
    role_label: ROLE_LABEL[opts.role] ?? "Customer",
    embed_model: model,
    match_count: topK,
    min_score: minScore,
  } as never);
  if (error) throw new Error(`match_support_kb: ${error.message}`);

  const rows = ((data as any[]) ?? []).map(
    (r): KbResult => ({
      article_id: r.article_id,
      chunk_id: r.chunk_id,
      title: r.title,
      locale: r.locale,
      type: r.type,
      content: r.content,
      similarity: Number(r.similarity) || 0,
      keyword_rank: Number(r.keyword_rank) || 0,
      score: Number(r.score) || 0,
    })
  );

  // Per article keep ONE language version: the user's language when that version
  // matched, else the locale of the article's best-scoring chunk.
  const preferred = preferredLocale(query, opts.locale);
  const isPreferred = (l: string) => l === preferred;
  const pick = new Map<string, KbResult>(); // article → chunk that decides its locale
  const articleScore = new Map<string, number>(); // article → best score in any locale
  for (const r of rows) {
    articleScore.set(r.article_id, Math.max(articleScore.get(r.article_id) ?? 0, r.score));
    const p = pick.get(r.article_id);
    if (
      !p ||
      (isPreferred(r.locale) && !isPreferred(p.locale)) ||
      (isPreferred(r.locale) === isPreferred(p.locale) && r.score > p.score)
    ) {
      pick.set(r.article_id, r);
    }
  }
  // Rank articles by their best score in ANY language, so preferring the user's
  // language changes which text is shown, not which articles win.
  const results = rows
    .filter((r) => pick.get(r.article_id)!.locale === r.locale)
    .sort(
      (a, b) =>
        articleScore.get(b.article_id)! - articleScore.get(a.article_id)! || b.score - a.score
    )
    .slice(0, topK);

  if (!results.length) return { mode: "empty", results: [], text: "" };
  return { mode: embedding ? "hybrid" : "keyword", results, text: formatKbText(results) };
}
