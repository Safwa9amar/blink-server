import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireStaff } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { SelectRoleResponse, selectRoleSchema } from "../../validators/auth";
import { ensureRoleProfile } from "./shared";

const app = router();

// ─── Select Role (staff only) ────────────────────────────────────────
// Sets the CALLER's users.role. It used to accept any signed-in user, so anyone
// could make themselves an agent (or rider / merchant) and skip verification.
// The app never calls it — role selection is local and sign-up sends the role
// to /auth/otp/register, /auth/google, /auth/apple — so it is staff-only now,
// tagged admin-* to stay out of the mobile client.
const route = createRoute({
  method: "post",
  path: "/role",
  operationId: "selectRole",
  tags: ["admin-auth"],
  security: bearer,
  middleware: [auth, requireStaff()] as const,
  request: { body: { ...json(selectRoleSchema), required: true } },
  responses: {
    200: json(SelectRoleResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
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
