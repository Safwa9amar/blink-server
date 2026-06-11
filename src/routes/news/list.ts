import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { FEED_COLUMNS, audienceFor } from "./shared";

const app = new Hono<AuthEnv>();

// ─── List the published news feed (role-targeted) ────────────────────
app.get("/", async (c) => {
  const user = c.get("user");
  const page = Math.max(1, Number(c.req.query("page") ?? 1));
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const offset = (page - 1) * limit;
  const nowIso = new Date().toISOString();

  let query = supabaseAdmin
    .from("news")
    .select(FEED_COLUMNS, { count: "exact" })
    .eq("status", "published")
    .overlaps("target_roles", audienceFor(user.role))
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("pinned", { ascending: false })
    .order("published_at", { ascending: false })
    .range(offset, offset + limit - 1);

  // Optional category filter (e.g. ?category=Offer).
  const category = c.req.query("category");
  if (category) query = query.eq("category", category);

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    news: data ?? [],
    pagination: { page, limit, total: count ?? 0 },
  });
});

export default app;
