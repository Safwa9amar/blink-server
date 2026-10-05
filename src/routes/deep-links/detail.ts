import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { DeepLinkResponse } from "../../validators/deep-links";

const app = router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Get one (by id or slug) ─────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getDeepLink",
  tags: ["admin-deep-links"],
  security: bearer,
  middleware: [auth] as const,
  request: { params: IdParam },
  responses: {
    200: json(DeepLinkResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { id: idOrSlug } = c.req.valid("param");
  const column = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabaseAdmin
    .from("deep_links")
    .select("*")
    .eq(column, idOrSlug)
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Deep link not found" }, 404);
  }

  return c.json({ deep_link: data }, 200);
});

export default app;
