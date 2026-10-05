import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { DeepLinkListResponse, listDeepLinksSchema } from "../../validators/deep-links";

const app = router();

// ─── List (filter + search + paginate) ───────────────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listDeepLinks",
  tags: ["admin-deep-links"],
  security: bearer,
  middleware: [auth] as const,
  request: { query: listDeepLinksSchema },
  responses: { 200: json(DeepLinkListResponse), 400: errorResponses[400], 401: errorResponses[401] },
});

app.openapi(route, async (c) => {
  const { page, limit, role, campaign, active, q } = c.req.valid("query");
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("deep_links")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (role) query = query.eq("role", role);
  if (campaign) query = query.eq("campaign", campaign);
  if (active) query = query.eq("is_active", active === "true");
  if (q) query = query.or(`slug.ilike.%${q}%,title.ilike.%${q}%`);

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json(
    {
      deep_links: data ?? [],
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
