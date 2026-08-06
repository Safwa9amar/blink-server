import { supabaseAdmin } from "../supabase";

// Preview length stored on the thread row for the inbox list.
export const PREVIEW_LEN = 140;

// Columns the dashboard needs (snake_case — supabase-js returns DB casing, NOT
// Drizzle's camelCase; reading camelCase off these rows yields undefined).
export const THREAD_COLUMNS =
  "id, customer_email, customer_name, user_id, subject, normalized_subject, status, assigned_agent_id, last_message_at, last_message_preview, last_direction, unread_for_staff, message_count, created_at, updated_at";
export const MESSAGE_COLUMNS =
  "id, thread_id, direction, message_id, in_reply_to, from_email, from_name, to_email, subject, body_text, body_html, sender_id, meta, created_at";

// Strip Re:/Fwd:/Fw:/Aw:/Sv:/Tr: (and bracketed counts) so a whole back-and-
// forth groups under one thread key. Lowercased + whitespace-collapsed.
export function normalizeSubject(subject: string | null | undefined): string {
  if (!subject) return "";
  return subject
    .replace(/^\s*((re|fwd|fw|aw|antw|sv|tr)\s*(\[\d+\])?\s*:\s*)+/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// A short single-line snippet of a body for the thread list.
export function previewOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LEN);
}

// A subject prefixed with "Re: " for an outbound reply (unless already there).
export function replySubject(subject: string | null | undefined): string {
  const s = (subject ?? "").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

// Link a customer email to a Blink user when the address matches users.email
// (case-insensitive). Returns the user id or null.
export async function matchUserByEmail(email: string): Promise<string | null> {
  if (!email) return null;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id")
    .ilike("email", email)
    .limit(1)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}
