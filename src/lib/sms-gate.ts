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
  const auth = Buffer.from(`${env.SMS_GATE_USERNAME}:${env.SMS_GATE_PASSWORD}`).toString("base64");

  const res = await fetch(`${env.SMS_GATE_URL}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ textMessage: { text }, phoneNumbers: [phone], simNumber: env.SMS_GATE_SIM_NUMBER }),
    // Supabase gives the Send SMS hook ~5s; fail before it does so the error is ours.
    signal: AbortSignal.timeout(4500),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SMS Gate ${res.status}: ${detail.slice(0, 200)}`);
  }
}
