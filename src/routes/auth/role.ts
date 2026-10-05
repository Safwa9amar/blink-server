import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { SelectRoleResponse, selectRoleSchema } from "../../validators/auth";
import { ensureRoleProfile } from "./shared";

const app = router();

// ─── Select Role (post-registration) ────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/role",
  operationId: "selectRole",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(selectRoleSchema), required: true } },
  responses: {
    200: json(SelectRoleResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");

  const { error } = await supabaseAdmin
    .from("users")
    .update({ role: body.role })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // Create the role-specific profile row(s) for the chosen role. All four roles
  // are handled here (see ensureRoleProfile) — previously only rider/agent were.
  await ensureRoleProfile(userId, body.role);

  return c.json({ message: "Role updated", role: body.role }, 200);
});

export default app;
