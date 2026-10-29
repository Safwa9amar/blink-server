import { env } from "../config/env";

// SMS Gate (https://sms-gate.app) — the free "SMS Gateway for Android" app turns
// an Android phone into the SMS sender. In Cloud mode the app registers with
// api.sms-gate.app and gets messages over push, so the phone only needs internet;
// texts leave from that phone's SIM. Credentials are shown in the app under
// Cloud server once it's connected.
//
// With SMS_GATE_USERNAME / PASSWORD set here, texts go straight to SMS Gate.
// Without them (the Render hosts), they go through the `sms-relay` Edge
// Function, which reads the same Supabase secrets as the OTP hook
// (supabase/functions/send-sms): one copy of the credentials for every host.

const RELAY_URL = `${env.SUPABASE_URL}/functions/v1/sms-relay`;
/** How long a relay "configured" answer is trusted. */
const RELAY_STATUS_TTL_MS = 60_000;

// sb_secret_ keys go on `apikey` only: on Authorization they're parsed as a JWT and refused.
const relayHeaders = () => ({ apikey: env.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" });

let relayStatus: { configured: boolean; at: number } | null = null;

/** This server holds the SMS Gate credentials itself. */
export function isSmsGateConfigured(): boolean {
  return Boolean(env.SMS_GATE_USERNAME && env.SMS_GATE_PASSWORD);
}

/** Texts can go out: directly, or through the relay once its secrets are set. */
export async function isSmsAvailable(): Promise<boolean> {
  if (isSmsGateConfigured()) return true;
  if (relayStatus && Date.now() - relayStatus.at < RELAY_STATUS_TTL_MS) return relayStatus.configured;
  try {
    const res = await fetch(RELAY_URL, { headers: relayHeaders(), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`sms-relay ${res.status}`);
    const { configured } = (await res.json()) as { configured?: unknown };
    relayStatus = { configured: configured === true, at: Date.now() };
    return relayStatus.configured;
  } catch (e) {
    console.error("[sms] relay status failed:", (e as Error).message);
    return false;
  }
}

export async function sendSms(phone: string, text: string): Promise<void> {
  // Supabase gives the Send SMS hook ~5s; fail before it does so the error is ours.
  await sendSmsTo([phone], text, 4500);
}

/**
 * Queue one text to several numbers (the phone sends one SMS per number). SMS Gate
 * accepts the message and the phone delivers it over the next seconds/minutes, so
 * a resolved promise means "queued on the gateway", not "delivered".
 */
export async function sendSmsTo(phones: string[], text: string, timeoutMs = 15_000): Promise<void> {
  const direct = isSmsGateConfigured();
  const res = direct
    ? await fetch(`${env.SMS_GATE_URL}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.SMS_GATE_USERNAME}:${env.SMS_GATE_PASSWORD}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ textMessage: { text }, phoneNumbers: phones, simNumber: env.SMS_GATE_SIM_NUMBER }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    : await fetch(RELAY_URL, {
        method: "POST",
        headers: relayHeaders(),
        body: JSON.stringify({ phones, text }),
        signal: AbortSignal.timeout(timeoutMs),
      });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${direct ? "SMS Gate" : "sms-relay"} ${res.status}: ${detail.slice(0, 200)}`);
  }
}
