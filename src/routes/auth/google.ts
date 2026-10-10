import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { SocialSyncResponse, socialSyncSchema, publicUser } from "../../validators/auth";
import { initialGrantedRoles, ROLE_NOT_HELD, roleConflictMessage, signUpConflict } from "../../lib/roles";
import { VALID_ROLES, ensureRoleProfile, type ServerRole } from "./shared";

const app = router();

// ─── Google OAuth profile sync ───────────────────────────────────────
// The mobile app completes Google OAuth directly against Supabase, so no
// server endpoint is in that loop. It then calls this (with the resulting
// access token) to sync the public.users profile. Unauthenticated because a
// brand-new user has no profile row yet, which the `auth` middleware rejects.
//
// The profile row is created ONLY once the user has chosen a role — the role is
// not defaulted. Two-step:
//   1. no `role` in body  → report whether the user is new (no row created).
//   2. `role` in body     → create the row with that role (first time only).
const route = createRoute({
  method: "post",
  path: "/google",
  operationId: "syncGoogleUser",
  tags: ["auth"],
  // Supabase access token from the OAuth flow (verified in-handler, not via
  // the `auth` middleware — a new user has no profile row yet).
  security: bearer,
  request: { body: { ...json(socialSyncSchema), required: false } },
  responses: {
    200: json(SocialSyncResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    409: json(ErrorSchema, "Account doesn't hold this role — add it from Become a Partner (code: role_not_held)"),
  },
});

app.openapi(route, async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  const token = header.slice(7);

  const {
    data: { user: supaUser },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !supaUser) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", supaUser.id)
    .single();

  // Parse the optional chosen role (used by both the existing- and new-user
  // branches below).
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const role = body.role as string | undefined;

  // Existing user.
  if (existingUser) {
    // A role the account doesn't hold is refused (the bug where "create
    // merchant" with an identity already signed up as a rider silently
    // returned the rider account); the message points to Become a Partner,
    // where the signed-in account unlocks more roles. A held role signs in.
    // An unknown role is a 400, never a 409 echoing the client's string.
    if (role && !VALID_ROLES.includes(role as ServerRole)) {
      return c.json({ error: `Invalid role: ${role}` }, 400);
    }
    if (role && signUpConflict(existingUser, role)) {
      return c.json({ error: roleConflictMessage(existingUser.role, role), code: ROLE_NOT_HELD }, 409);
    }
    // Backfill the role profile if missing (e.g. account predates its role
    // table), then return the existing profile.
    await ensureRoleProfile(existingUser.id, existingUser.role as ServerRole);
    return c.json({ is_new_user: false, user: publicUser(existingUser) }, 200);
  }

  // Step 1: no role yet — report new, create nothing.
  if (!role) {
    return c.json({ is_new_user: true, user: null }, 200);
  }

  // Step 2: create the profile with the chosen role.
  if (!VALID_ROLES.includes(role as ServerRole)) {
    return c.json({ error: `Invalid role: ${role}` }, 400);
  }

  const meta = supaUser.user_metadata ?? {};
  const { data: created, error: insertError } = await supabaseAdmin
    .from("users")
    .insert({
      id: supaUser.id,
      email: supaUser.email ?? null,
      first_name: meta.given_name ?? meta.name ?? null,
      last_name: meta.family_name ?? null,
      role: role as ServerRole,
      granted_roles: initialGrantedRoles(role as ServerRole),
    })
    .select("*")
    .single();

  if (insertError) {
    return c.json({ error: insertError.message }, 400);
  }

  // Create the role-specific profile row(s) for the chosen role (mirrors POST
  // /auth/role). All four roles are handled — without this, a role's profile
  // screen can't load or save.
  await ensureRoleProfile(supaUser.id, role as ServerRole);

  return c.json({ is_new_user: true, user: publicUser(created) }, 200);
});

export default app;
