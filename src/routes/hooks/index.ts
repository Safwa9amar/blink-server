import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { env } from "../../config/env";
import { isSmsGateConfigured, sendSms } from "../../lib/sms-gate";

// Supabase Auth hooks. NOT behind `auth` (Supabase has no user JWT) — each
// request is signed with the hook secret (Standard Webhooks) and verified here.
const app = new Hono();

// Supabase reads non-2xx hook replies in this shape and surfaces `message`.
const hookError = (message: string, http_code: number) => ({ error: { http_code, message } });

// Standard Webhooks: base64(HMAC-SHA256(key, `${id}.${timestamp}.${body}`)), where
// the key is the base64 part of the Supabase secret ("v1,whsec_<base64>").
function verifySignature(secret: string, headers: Headers, body: string): boolean {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!id || !timestamp || !signatures) return false;

  // Reject replays older/newer than 5 minutes.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const key = Buffer.from(secret.replace(/^v1,/, "").replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  return signatures.split(" ").some((entry) => {
    const [version, sig] = entry.split(",");
    if (version !== "v1" || !sig) return false;
    const given = Buffer.from(sig, "base64");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

// POST /hooks/send-sms — Supabase "Send SMS" hook (Dashboard → Authentication →
// Hooks). Supabase generates and verifies the OTP itself; we only deliver it
// through SMS Gate. Point the hook at https://blink.greenpedal.net/hooks/send-sms
// and put the generated secret in SEND_SMS_HOOK_SECRET.
app.post("/send-sms", async (c) => {
  if (!env.SEND_SMS_HOOK_SECRET) {
    return c.json(hookError("Send SMS hook is not configured", 500), 500);
  }

  const body = await c.req.text();
  if (!verifySignature(env.SEND_SMS_HOOK_SECRET, c.req.raw.headers, body)) {
    return c.json(hookError("Invalid webhook signature", 401), 401);
  }

  const { user, sms } = JSON.parse(body) as { user: { phone: string }; sms: { otp: string } };
  // auth.users stores phones without the leading "+".
  const phone = user.phone.startsWith("+") ? user.phone : `+${user.phone}`;

  if (!isSmsGateConfigured()) {
    // Local server without a phone attached: print the code instead of failing.
    if (env.NODE_ENV !== "production") {
      console.log(`[send-sms] SMS Gate not configured — OTP for ${phone}: ${sms.otp}`);
      return c.json({}, 200);
    }
    return c.json(hookError("SMS gateway is not configured", 500), 500);
  }

  try {
    await sendSms(phone, `Blink: ${sms.otp} is your verification code. Don't share it with anyone.`);
  } catch (err) {
    console.error("[send-sms] delivery failed:", err);
    return c.json(hookError("Could not send the verification SMS", 500), 500);
  }

  return c.json({}, 200);
});

export default app;
