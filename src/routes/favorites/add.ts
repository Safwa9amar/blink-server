import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, OkSchema, router } from "../../openapi";
import { favoriteBodySchema } from "../../validators/favorites";

const app = router();

// ─── Add favorite (idempotent) ───────────────────────────────────────
const route = createRoute({
  method: "put",
  path: "/",
  operationId: "addFavorite",
  tags: ["favorites"],
  security: bearer,
  request: { body: { ...json(favoriteBodySchema), required: true } },
  responses: { 200: json(OkSchema), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const { error } = await supabaseAdmin
    .from("customer_favorites")
    .upsert(
      { user_id: user.id, target_type: body.target_type, target_id: body.target_id },
      { onConflict: "user_id,target_type,target_id", ignoreDuplicates: true }
    );

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ success: true }, 200);
});

export default app;
