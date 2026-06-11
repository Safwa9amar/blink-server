import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { verifyOtpSchema } from "../../validators/auth";

const app = new Hono<AuthEnv>();

// ─── Verify OTP ──────────────────────────────────────────────────────
app.post("/otp/verify", async (c) => {
  const body = verifyOtpSchema.parse(await c.req.json());

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

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    is_new_user: isNewUser,
    user: existingUser ?? { id: data.user!.id, phone_number: body.phone_number },
  });
});

export default app;
