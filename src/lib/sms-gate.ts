import { env } from "../config/env";

// SMS Gate (https://sms-gate.app) — the free "SMS Gateway for Android" app turns
// an Android phone into the SMS sender. In Cloud mode the app registers with
// api.sms-gate.app and gets messages over push, so the phone only needs internet;
// texts leave from that phone's SIM. Credentials are shown in the app under
// Cloud server once it's connected.

export function isSmsGateConfigured(): boolean {
  return Boolean(env.SMS_GATE_USERNAME && env.SMS_GATE_PASSWORD);
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
  const auth = Buffer.from(`${env.SMS_GATE_USERNAME}:${env.SMS_GATE_PASSWORD}`).toString("base64");

  const res = await fetch(`${env.SMS_GATE_URL}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: phones, simNumber: env.SMS_GATE_SIM_NUMBER }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SMS Gate ${res.status}: ${detail.slice(0, 200)}`);
  }
}
