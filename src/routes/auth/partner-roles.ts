import { grantRole, normalizeGranted } from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import type { UserRow } from "../../types/database";
import { AuthProfileResponse, partnerRoleSchema } from "../../validators/auth";
import { authProfilePayload } from "./profile-payload";
import { ensureRoleProfile } from "./shared";

const app = router();

// ─── Unlock a partner role (Become a Partner) ───────────────────────
// Adds rider / merchant / agent to users.granted_roles and creates that role's
// profile row(s); agents also get their blank `under_review` shop
// (ensureRoleProfile). Idempotent. Never changes the active role — that's
// POST /auth/active-role. The role is unlocked at once; each role's own checks
// (rider verification, agent shop review, store review) gate real work.
const route = createRoute({
  method: "post",
  path: "/partner-roles",
  operationId: "grantPartnerRole",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(partnerRoleSchema), required: true } },
  responses: {
    200: json(AuthProfileResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { role } = c.req.valid("json");
  const { granted, added } = grantRole(normalizeGranted(user.granted_roles, user.role), role);

  // Use the row the DB hands back (normalised by the trigger), not an
  // in-memory copy: the payload must reflect what was actually persisted.
  let row: UserRow = user;
  if (added) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .update({ granted_roles: granted })
      .eq("id", user.id)
      .select("*")
      .single();
    if (error || !data) {
      return c.json({ error: error?.message ?? "User profile not found" }, 400);
    }
    row = data as UserRow;
  }

  await ensureRoleProfile(user.id, role);

  // rider_profiles.is_available defaults to true and dispatch offers jobs on
  // that flag alone: a rider role unlocked from another role starts offline
  // until the person goes online as a rider.
  if (added && role === "rider") {
    await supabaseAdmin.from("rider_profiles").update({ is_available: false }).eq("user_id", user.id);
  }

  return c.json(await authProfilePayload(row), 200);
});

export default app;
