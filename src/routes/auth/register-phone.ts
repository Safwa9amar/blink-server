import { isAuthOutage } from "../../lib/auth-outage";
import { retryOnNetworkError } from "../../lib/db-retry";
import { supabaseAdmin } from "../../lib/supabase";
import { initialGrantedRoles, PHONE_IN_USE, ROLE_NOT_HELD, roleConflictMessage, signUpConflict, type AppRole } from "../../lib/roles";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { registerPhoneSchema, SocialSyncResponse, publicUser } from "../../validators/auth";
import { ensureRoleProfile } from "./shared";

const app = router();

// ─── Finish phone sign-up ────────────────────────────────────────────
// Second half of the OTP flow for a new user: creates the public.users row with
// the verified phone, the details form and the chosen role. Verifies the bearer
// in-handler (not the `auth` middleware) because the row doesn't exist yet.
// Idempotent for the same role, so a retried request is harmless.
const route = createRoute({
  method: "post",
  path: "/otp/register",
  operationId: "registerPhoneUser",
  tags: ["auth"],
  security: bearer,
  request: { body: { ...json(registerPhoneSchema), required: true } },
  responses: {
    200: json(SocialSyncResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    409: json(ErrorSchema, "Account doesn't hold this role (add it from Become a Partner; code: role_not_held), or phone already in use (code: phone_in_use)"),
    503: json(ErrorSchema, "Supabase unreachable — safe to retry"),
  },
});

app.openapi(route, async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }

  // 503, not 401, when Supabase can't be reached: the app signs the user out
  // on a 401, which would throw away a half-finished sign-up.
  const unavailable = () =>
    c.json({ error: "Service temporarily unavailable, please retry" }, 503);

  const token = header.slice(7);
  let auth = await supabaseAdmin.auth.getUser(token);
  // One retry: a network blip reaching Supabase Auth is common in dev.
  if (isAuthOutage(auth.error)) auth = await supabaseAdmin.auth.getUser(token);
  const {
    data: { user: supaUser },
    error,
  } = auth;

  if (isAuthOutage(error)) return unavailable();
  if (error || !supaUser) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
  if (!supaUser.phone) {
    return c.json({ error: "This session has no verified phone number" }, 400);
  }

  const body = c.req.valid("json");

  const findOwnRow = () =>
    supabaseAdmin.from("users").select("*").eq("id", supaUser.id).maybeSingle();

  // Already registered: a role the account holds → finish (backfill the role
  // profile; the active role is left alone), any other role → refuse and point
  // to Become a Partner, where the signed-in account unlocks more roles.
  const finishExisting = async (row: NonNullable<Awaited<ReturnType<typeof findOwnRow>>["data"]>, isNewUser: boolean) => {
    if (signUpConflict(row, body.role)) {
      return c.json({ error: roleConflictMessage(row.role, body.role), code: ROLE_NOT_HELD }, 409);
    }
    await ensureRoleProfile(row.id, row.role as AppRole);
    return c.json({ is_new_user: isNewUser, user: publicUser(row) }, 200);
  };

  // postgrest-js already retried this read; an error here means Supabase is
  // unreachable — never fall through to the insert on a guess.
  const { data: existingUser, error: lookupError } = await findOwnRow();
  if (lookupError) return unavailable();
  if (existingUser) return finishExisting(existingUser, false);

  // auth.users stores the phone without "+"; public.users keeps E.164.
  const phone = supaUser.phone.startsWith("+") ? supaUser.phone : `+${supaUser.phone}`;

  // Keyed by the auth user id, so replaying a dropped insert is safe: if the
  // first attempt landed, the replay hits the primary key (handled below).
  const { data: created, error: insertError, status } = await retryOnNetworkError(() =>
    supabaseAdmin
      .from("users")
      .insert({
        id: supaUser.id,
        phone_number: phone,
        first_name: body.first_name,
        last_name: body.last_name,
        middle_name: body.middle_name || null,
        email: body.email ?? null,
        role: body.role,
        granted_roles: initialGrantedRoles(body.role),
      })
      .select("*")
      .single()
  );

  if (insertError) {
    if (status === 0) {
      console.error("[auth/otp/register] Supabase unreachable:", insertError.details);
      return unavailable();
    }
    if (insertError.code === "23505") {
      // Our own earlier attempt may have landed with its response lost — then
      // the row is this user's, not a clash.
      const { data: ownRow } = await findOwnRow();
      if (ownRow) return finishExisting(ownRow, true);
      // phone_number is UNIQUE — another account (e.g. OAuth) already claimed it.
      return c.json({ error: "This phone number is already linked to another account", code: PHONE_IN_USE }, 409);
    }
    return c.json({ error: insertError.message }, 400);
  }

  await ensureRoleProfile(supaUser.id, body.role);

  return c.json({ is_new_user: true, user: publicUser(created) }, 200);
});

export default app;
