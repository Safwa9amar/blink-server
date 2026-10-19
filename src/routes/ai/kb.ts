import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../middleware/auth";
import { requireStaffRole } from "../../middleware/staff-roles";
import { getAiConfig, buildProviderFor, type ProviderId } from "../../lib/ai-settings";
import { getKbIndexStatus, isKbSyncing, syncKbIndex } from "../../lib/support-kb-index";
import { retrieveKb } from "../../lib/support-kb-retrieval";

// Staff endpoints for the support-bot RAG index (plain Hono — not in the OpenAPI spec).
const app = new Hono<AuthEnv>();

const PROVIDERS: ProviderId[] = ["openrouter", "ollama", "lmstudio"];

// Reindex and search spend paid embedding calls: support admins only (+ super),
// matching who can open Support → AI in the dashboard.
app.use("/kb/*", requireStaffRole("support_admin"));
app.use("/embedding-models", requireStaffRole("support_admin"));

// ─── Index status ────────────────────────────────────────────────────
app.get("/kb/status", async (c) => {
  try {
    const cfg = await getAiConfig({ fresh: true });
    return c.json({ status: await getKbIndexStatus(cfg) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ─── Kick off a (background) reindex ─────────────────────────────────
const reindexBody = z.object({ full: z.boolean().optional() });
app.post("/kb/reindex", async (c) => {
  const parsed = reindexBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const wasSyncing = isKbSyncing(); // then syncKbIndex queues one more pass instead
  void syncKbIndex({ full: parsed.data.full }).catch(() => {
    /* recorded in index status (last_error) */
  });
  return c.json({ started: !wasSyncing }, 202);
});

// ─── Test search ─────────────────────────────────────────────────────
const searchBody = z.object({
  query: z.string().min(1).max(1000),
  role: z.enum(["customer", "rider", "merchant", "agent"]),
  locale: z.enum(["en", "fr", "ar"]).optional(),
  top_k: z.number().int().min(1).max(20).optional(),
  min_score: z.number().min(0).max(1).optional(),
});
app.post("/kb/search", async (c) => {
  const parsed = searchBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const b = parsed.data;
  try {
    const cfg = await getAiConfig({ fresh: true });
    const r = await retrieveKb({
      role: b.role,
      locale: b.locale ?? "en",
      query: b.query,
      cfg,
      topK: b.top_k,
      minScore: b.min_score,
    });
    return c.json({
      mode: r.mode,
      results: r.results.map((x) => ({
        article_id: x.article_id,
        title: x.title,
        locale: x.locale,
        type: x.type,
        content: x.content,
        similarity: x.similarity,
        keyword_rank: x.keyword_rank,
        score: x.score,
      })),
    });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 500);
  }
});

// ─── Embedding models for a provider ─────────────────────────────────
app.get("/embedding-models", async (c) => {
  const q = c.req.query("provider") as ProviderId;
  const provider: ProviderId = PROVIDERS.includes(q) ? q : "openrouter";
  try {
    const p = await buildProviderFor(provider);
    return c.json({ models: (await p.listEmbeddingModels?.()) ?? [] });
  } catch (e) {
    console.error("[ai/embedding-models] failed", (e as Error).message);
    return c.json({ models: [] });
  }
});

export default app;
