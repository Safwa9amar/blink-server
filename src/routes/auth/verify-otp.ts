import { supabaseAdmin } from "../../lib/supabase";
import { createRoute, errorResponses, json, router } from "../../openapi";
import { VerifyOtpResponse, verifyOtpSchema, publicUser } from "../../validators/auth";

const app = router();

// ─── Verify OTP ──────────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/otp/verify",
  operationId: "verifyOtp",
  tags: ["auth"],
  request: { body: { ...json(verifyOtpSchema), required: true } },
  responses: { 200: json(VerifyOtpResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");

  const { data, error } = await supabaseAdmin.auth.verifyOtp({
    phone: body.phone_number,
    token: body.otp,
    type: "sms",
  });

  if (error || !data.session) {
    return c.json({ error: error?.message ?? "Verification failed" }, 400);
  }

  // Check if user profile exists
  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", data.user!.id)
    .single();

  const isNewUser = !existingUser;

  if (isNewUser) {
    // Create user profile stub
    await supabaseAdmin.from("users").insert({
      id: data.user!.id,
      phone_number: body.phone_number,
      role: "customer", // default, changed in role selection
    });
  }

  return c.json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      is_new_user: isNewUser,
      user: publicUser(existingUser) ?? { id: data.user!.id, phone_number: body.phone_number },
    },
    200
  );
});

export default app;
