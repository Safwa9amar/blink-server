import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  listSupportArticlesQuery,
  SupportArticleListResponse,
  SupportArticleResponse,
} from "../../validators/support-content";
import { audienceFor } from "./shared";

const app = router();

// ─── List published articles/FAQs for this role ─────────────────────
// Optional ?type=article|faq and ?category=<key> filters. All content_*
// columns are returned so the app picks the locale client-side.
const listRoute = createRoute({
  method: "get",
  path: "/articles",
  operationId: "listSupportArticles",
  tags: ["support-content"],
  security: bearer,
  request: { query: listSupportArticlesQuery },
  responses: { 200: json(SupportArticleListResponse), 400: errorResponses[400] },
});

app.openapi(listRoute, async (c) => {
  const user = c.get("user");
  const q = c.req.valid("query");

  let query = supabaseAdmin
    .from("support_articles")
    .select("*")
    .eq("status", "published")
    .overlaps("target_roles", audienceFor(user.role))
    .order("sort", { ascending: true })
    .order("created_at", { ascending: false });

  const type = q.type;
  if (type === "article" || type === "faq") query = query.eq("type", type);

  const category = q.category;
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ articles: data ?? [] }, 200);
});

// ─── Get a single published article — counts a view ─────────────────
const detailRoute = createRoute({
  method: "get",
  path: "/articles/{id}",
  operationId: "getSupportArticle",
  tags: ["support-content"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(SupportArticleResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(detailRoute, async (c) => {
  const { id } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("support_articles")
    .select("*")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Article not found" }, 404);
  }

  // Best-effort view count (read-modify-write — fine for an engagement counter).
  const views = (data.views ?? 0) + 1;
  await supabaseAdmin.from("support_articles").update({ views }).eq("id", data.id);

  return c.json({ article: { ...data, views } }, 200);
});

export default app;
