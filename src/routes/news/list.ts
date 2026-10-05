import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listNewsQuery, NewsListResponse } from "../../validators/news";
import { FEED_COLUMNS, audienceFor } from "./shared";

const app = router();

// ─── List the published news feed (role-targeted) ────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listNews",
  tags: ["news"],
  security: bearer,
  request: { query: listNewsQuery },
  responses: { 200: json(NewsListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const q = c.req.valid("query");
  const page = Math.max(1, Number(q.page ?? 1));
  const limit = Math.min(50, Math.max(1, Number(q.limit ?? 20)));
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
  const category = q.category;
  if (category) query = query.eq("category", category);

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json(
    {
      news: data ?? [],
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
