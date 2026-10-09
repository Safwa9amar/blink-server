// Supabase Auth "Send SMS" hook → SMS Gate (the Android phone that sends OTPs).
//
// Same job as blink-server's POST /hooks/send-sms, but hosted by Supabase so OTP
// delivery doesn't depend on the API host being up (or awake). Supabase still
// generates and verifies the code; this only delivers it.
//
// Deploy with verify_jwt = false — Supabase calls hooks without a user JWT; the
// Standard Webhooks signature below is the auth. Secrets (Edge Function secrets):
//   SEND_SMS_HOOK_SECRET   "v1,whsec_…" from Authentication → Hooks
//   SMS_GATE_USERNAME / SMS_GATE_PASSWORD   SMS Gate app → Cloud server
//   SMS_GATE_SIM_NUMBER    optional SIM slot (1-based); this phone needs 2
//   SMS_GATE_URL           optional, defaults to the public cloud relay
import { Webhook } from "npm:standardwebhooks@1.0.0";

const hookSecret = (Deno.env.get("SEND_SMS_HOOK_SECRET") ?? "").replace(/^v1,whsec_/, "");
const gateUrl = (Deno.env.get("SMS_GATE_URL") || "https://api.sms-gate.app/3rdparty/v1").replace(/\/$/, "");
const gateUser = Deno.env.get("SMS_GATE_USERNAME") ?? "";
const gatePass = Deno.env.get("SMS_GATE_PASSWORD") ?? "";
const simNumber = Number(Deno.env.get("SMS_GATE_SIM_NUMBER")) || undefined;

// Supabase reads non-2xx hook replies in this shape and surfaces `message`.
const hookError = (message: string, http_code: number) =>
  Response.json({ error: { http_code, message } }, { status: http_code });

Deno.serve(async (req) => {
  if (req.method !== "POST") return hookError("Method not allowed", 405);
  if (!hookSecret || !gateUser || !gatePass) {
    return hookError("Send SMS hook is not configured", 500);
  }

  const payload = await req.text();
  let user: { phone: string };
  let sms: { otp: string };
  try {
    ({ user, sms } = new Webhook(hookSecret).verify(payload, Object.fromEntries(req.headers)) as {
      user: { phone: string };
      sms: { otp: string };
    });
  } catch {
    return hookError("Invalid webhook signature", 401);
  }

  // auth.users stores phones without the leading "+".
  const phone = user.phone.startsWith("+") ? user.phone : `+${user.phone}`;

  try {
    const res = await fetch(`${gateUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${gateUser}:${gatePass}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        textMessage: { text: `Blink: ${sms.otp} is your verification code. Don't share it with anyone.` },
        phoneNumbers: [phone],
        simNumber,
      }),
      // Supabase gives hooks ~5s; fail first so the error is ours.
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) throw new Error(`SMS Gate ${res.status}: ${(await res.text()).slice(0, 200)}`);
  } catch (err) {
    console.error("[send-sms] delivery failed:", err);
    return hookError("Could not send the verification SMS", 500);
  }

  return Response.json({});
});
