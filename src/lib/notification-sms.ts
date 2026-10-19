// The SMS channel of staff notifications: text a notification's recipients
// through SMS Gate (the same Android-phone gateway as the OTP hook). Used by the
// dashboard's "Send now" (POST /notifications/admin/{id}/sms) and by scheduled
// sends (lib/scheduled-notifications.ts).
import { env } from "../config/env";
import { isSmsGateConfigured, sendSmsTo } from "./sms-gate";
import { smsPhone, smsText, type SmsLang, type SmsSource } from "./sms-text";
import { supabaseAdmin } from "./supabase";

/** Numbers per SMS Gate request (the phone still sends one SMS per number). */
const BATCH = 50;
/** PostgREST returns at most 1000 rows; ids per `.in()` stay well under URL limits. */
const PAGE = 1000;
const ID_CHUNK = 200;

export type SmsErrorCode = "sms_not_configured" | "sms_over_limit" | "not_found";

export class SmsError extends Error {
  constructor(
    public readonly code: SmsErrorCode,
    message: string,
    public readonly max?: number
  ) {
    super(message);
  }
}

export interface SmsResult {
  /** Numbers SMS Gate accepted (the phone delivers them shortly after). */
  queued: number;
  /** Recipients without a usable phone number. */
  no_phone: number;
  /** Numbers in batches the gateway refused. */
  failed: number;
}

export function smsStatus(): { configured: boolean; max: number } {
  return { configured: isSmsGateConfigured(), max: env.SMS_BROADCAST_MAX };
}

/** Distinct E.164 numbers for these users, and how many had none usable. */
export async function phonesFor(userIds: string[]): Promise<{ phones: string[]; noPhone: number }> {
  const ids = [...new Set(userIds)];
  const phones = new Set<string>();
  let noPhone = 0;
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, phone_number")
      .in("id", ids.slice(i, i + ID_CHUNK));
    if (error) throw new Error(`[sms] phone lookup failed: ${error.message}`);
    for (const u of (data ?? []) as { phone_number: string | null }[]) {
      const p = smsPhone(u.phone_number);
      if (p) phones.add(p);
      else noPhone++;
    }
  }
  return { phones: [...phones], noPhone };
}

/**
 * Text these users. Refuses (SmsError, nothing sent) when the gateway isn't
 * configured or the audience is over SMS_BROADCAST_MAX numbers. A refused batch
 * is counted in `failed` and the rest still go out.
 */
export async function smsUsers(userIds: string[], text: string): Promise<SmsResult> {
  if (!isSmsGateConfigured()) throw new SmsError("sms_not_configured", "The SMS gateway is not configured on the server.");
  const { phones, noPhone } = await phonesFor(userIds);
  if (phones.length > env.SMS_BROADCAST_MAX) {
    throw new SmsError(
      "sms_over_limit",
      `SMS is limited to ${env.SMS_BROADCAST_MAX} numbers per send; this audience has ${phones.length}.`,
      env.SMS_BROADCAST_MAX
    );
  }
  let queued = 0;
  let failed = 0;
  for (let i = 0; i < phones.length; i += BATCH) {
    const batch = phones.slice(i, i + BATCH);
    try {
      await sendSmsTo(batch, text);
      queued += batch.length;
    } catch (e) {
      failed += batch.length;
      console.error("[sms] batch refused:", (e as Error).message);
    }
  }
  return { queued, no_phone: noPhone, failed };
}

/** Every user a notification was delivered to (one per user, whatever the role feeds). */
async function recipientIds(notificationId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("notification_recipients")
      .select("user_id")
      .eq("notification_id", notificationId)
      .order("user_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`[sms] recipients lookup failed: ${error.message}`);
    for (const r of (data ?? []) as { user_id: string }[]) ids.add(r.user_id);
    if (!data || data.length < PAGE) break;
  }
  return [...ids];
}

/** Text the recipients of an existing notification, in one language. */
export async function smsNotification(notificationId: string, lang: SmsLang): Promise<SmsResult> {
  const { data: notif, error } = await supabaseAdmin
    .from("notifications")
    .select("title, description, content_eng, content_fr, content_ar")
    .eq("id", notificationId)
    .maybeSingle();
  if (error) throw new Error(`[sms] notification lookup failed: ${error.message}`);
  if (!notif) throw new SmsError("not_found", "Notification not found.");
  return smsUsers(await recipientIds(notificationId), smsText(notif as SmsSource, lang));
}
