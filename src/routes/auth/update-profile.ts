import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AuthUserResponse, updateProfileSchema, publicUser } from "../../validators/auth";

const app = router();

// ─── Update Profile ──────────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/profile",
  operationId: "updateAuthProfile",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(updateProfileSchema), required: true } },
  responses: {
    200: json(AuthUserResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(body)
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ user: publicUser(data) }, 200);
});

export default app;
