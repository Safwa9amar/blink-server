import { createAuthClient, supabaseAdmin } from "../../lib/supabase";
import { createRoute, errorResponses, json, router } from "../../openapi";
import { VerifyOtpResponse, verifyOtpSchema, publicUser } from "../../validators/auth";
import { ensureRoleProfile, type ServerRole } from "./shared";

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

  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", data.user.id)
    .maybeSingle();

  if (existingUser) {
    // Backfill the role profile for accounts that predate their role table.
    await ensureRoleProfile(existingUser.id, existingUser.role as ServerRole);
  }

  return c.json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      is_new_user: !existingUser,
      user: existingUser ? publicUser(existingUser) : null,
    },
    200
  );
});

export default app;
