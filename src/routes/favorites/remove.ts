import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, OkSchema, router } from "../../openapi";
import { FavoriteParams } from "../../validators/favorites";

const app = router();

// ─── Remove favorite ─────────────────────────────────────────────────
const route = createRoute({
  method: "delete",
  path: "/{target_type}/{target_id}",
  operationId: "removeFavorite",
  tags: ["favorites"],
  security: bearer,
  request: { params: FavoriteParams },
  responses: { 200: json(OkSchema), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { target_type, target_id } = c.req.valid("param");

  const { error } = await supabaseAdmin
    .from("customer_favorites")
    .delete()
    .eq("user_id", user.id)
    .eq("target_type", target_type)
    .eq("target_id", target_id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ success: true }, 200);
});

export default app;
