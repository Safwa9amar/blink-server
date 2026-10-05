import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { DeepLinkDeletedResponse } from "../../validators/deep-links";

const app = router();

// ─── Delete (by id) ──────────────────────────────────────────────────
const route = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "deleteDeepLink",
  tags: ["admin-deep-links"],
  security: bearer,
  middleware: [auth] as const,
  request: { params: IdParam },
  responses: { 200: json(DeepLinkDeletedResponse), 400: errorResponses[400], 401: errorResponses[401] },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");

  const { error } = await supabaseAdmin.from("deep_links").delete().eq("id", id);
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Deep link deleted" }, 200);
});

export default app;
