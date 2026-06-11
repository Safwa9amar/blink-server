import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { sendOtpSchema } from "../../validators/auth";

const app = new Hono<AuthEnv>();

// ─── Send OTP ────────────────────────────────────────────────────────
app.post("/otp/send", async (c) => {
  const body = sendOtpSchema.parse(await c.req.json());

  const { error } = await supabaseAdmin.auth.signInWithOtp({
    phone: body.phone_number,
  });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "OTP sent successfully" });
});

export default app;
