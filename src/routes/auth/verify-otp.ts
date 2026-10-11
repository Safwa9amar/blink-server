import { createAuthClient, supabaseAdmin } from "../../lib/supabase";
import { createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { VerifyOtpResponse, verifyOtpSchema, publicUser } from "../../validators/auth";
import { e164, ensureRoleProfile, type ServerRole } from "./shared";

const app = router();

// ─── Verify OTP ──────────────────────────────────────────────────────
// Returns a Supabase session either way. A returning user gets their profile;
// a new one gets `user: null` and finishes with POST /auth/otp/register once
// they've filled their details and picked a role (same rule as OAuth — no row
// with a defaulted role).
const route = createRoute({
  method: "post",
  path: "/otp/verify",
  operationId: "verifyOtp",
  tags: ["auth"],
  request: { body: { ...json(verifyOtpSchema), required: true } },
  responses: {
    200: json(VerifyOtpResponse),
    400: errorResponses[400],
    429: errorResponses[429],
    503: json(ErrorSchema, "Supabase unreachable — safe to retry"),
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");

  const { data, error } = await createAuthClient().auth.verifyOtp({
    phone: body.phone_number,
    token: body.otp,
    type: "sms",
  });

  if (error || !data.session || !data.user) {
    if (error?.status === 429) {
      return c.json({ error: error.message }, 429);
    }
    return c.json({ error: error?.message ?? "Verification failed" }, 400);
  }

  // 503, not a guess: a lookup that didn't answer must never turn a returning
  // user into a "new" one (postgrest-js already retried the read).
  const unavailable = () =>
    c.json({ error: "Service temporarily unavailable, please retry" }, 503);

  const { data: existingUser, error: lookupError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", data.user.id)
    .maybeSingle();
  if (lookupError) return unavailable();

  if (existingUser) {
    // Backfill the role profile for accounts that predate their role table.
    await ensureRoleProfile(existingUser.id, existingUser.role as ServerRole);
  }

  // No account behind this login, but the number may be saved (unverified) on
  // an account made with Google/Apple. That's no new user — signing up would
  // fail with phone_in_use. Name the provider so the app can have them sign
  // in and verify the number (POST /auth/phone/link).
  let linkProvider: string | null = null;
  if (!existingUser && data.user.phone) {
    const { data: owner, error: ownerError } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("phone_number", e164(data.user.phone))
      .maybeSingle();
    if (ownerError) return unavailable();
    if (owner) {
      const { data: ownerAuth, error: ownerAuthError } = await supabaseAdmin.auth.admin.getUserById(owner.id);
      if (ownerAuthError) return unavailable();
      linkProvider = ownerAuth.user.app_metadata?.provider ?? "email";
    }
  }

  return c.json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      is_new_user: !existingUser && !linkProvider,
      user: existingUser ? publicUser(existingUser) : null,
      link_provider: linkProvider,
    },
    200
  );
});

export default app;
