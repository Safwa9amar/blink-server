import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { NewsDetailResponse, NewsIdParam } from "../../validators/news";
import { FEED_COLUMNS, UUID_RE } from "./shared";

const app = router();

// ─── Get a single published post (by id or slug) — counts a view ─────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getNews",
  tags: ["news"],
  security: bearer,
  request: { params: NewsIdParam },
  responses: {
    200: json(NewsDetailResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { id: idOrSlug } = c.req.valid("param");
  const lookupColumn = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabaseAdmin
    .from("news")
    .select(FEED_COLUMNS)
    .eq(lookupColumn, idOrSlug)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "News post not found" }, 404);
  }

  // Best-effort view count (read-modify-write — fine for an engagement counter).
  const views = (data.views ?? 0) + 1;
  await supabaseAdmin.from("news").update({ views }).eq("id", data.id);

  return c.json({ news: { ...data, views } }, 200);
});

export default app;
