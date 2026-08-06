import nodemailer from "nodemailer";
import { env } from "../../config/env";
import { supabaseAdmin } from "../supabase";
import { MESSAGE_COLUMNS, previewOf, replySubject, THREAD_COLUMNS } from "./shared";
import { bumpThread } from "./imap";
import type { EmailMessageRow } from "../../db";

// True when SMTP is configured enough to send. The reply route and the
// dashboard surface this so staff see "email not configured" instead of a throw.
export function emailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS);
}

// Lazily built + cached transport (a pooled connection to the cPanel SMTP host).
let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });
  }
  return transporter;
}

export interface ReplyResult {
  message: EmailMessageRow | null;
  error: string | null;
}

// Send a staff reply on a thread over SMTP and log it as an outbound message.
// The reply is anchored (In-Reply-To/References) to the thread's latest
// Message-ID so it lands in the customer's existing email thread.
export async function sendEmailReply(
  threadId: string,
  staffUserId: string,
  body: string,
  staffName?: string | null
): Promise<ReplyResult> {
  if (!emailConfigured()) return { message: null, error: "Email is not configured" };

  const { data: threadRow } = await supabaseAdmin
    .from("email_threads")
    .select(THREAD_COLUMNS)
    .eq("id", threadId)
    .maybeSingle();
  if (!threadRow) return { message: null, error: "Thread not found" };
  // supabase-js returns snake_case columns (not Drizzle's camelCase EmailThreadRow).
  const thread = threadRow as unknown as { customer_email: string; subject: string | null };

  const { data: last } = await supabaseAdmin
    .from("email_messages")
    .select("message_id")
    .eq("thread_id", threadId)
    .not("message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const inReplyTo = (last as { message_id: string } | null)?.message_id ?? undefined;

  const from = env.SMTP_FROM || env.SMTP_USER || "";
  const to = thread.customer_email;
  const subject = replySubject(thread.subject);

  let sentId: string | undefined;
  try {
    const info = await getTransporter().sendMail({
      from,
      to,
      subject,
      text: body,
      inReplyTo,
      references: inReplyTo,
    });
    sentId = info.messageId;
  } catch (e) {
    return { message: null, error: (e as Error).message };
  }

  const { data: inserted, error: insErr } = await supabaseAdmin
    .from("email_messages")
    .insert({
      thread_id: threadId,
      direction: "outbound",
      message_id: sentId ?? null,
      in_reply_to: inReplyTo ?? null,
      from_email: from,
      from_name: staffName ?? "Blink Support",
      to_email: to,
      subject,
      body_text: body,
      body_html: null,
      sender_id: staffUserId,
      meta: null,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (insErr || !inserted) {
    // The email WAS sent; only the audit row failed. Report a soft error.
    console.error("[email] reply sent but log insert failed", insErr?.message);
    return { message: null, error: insErr?.message ?? "reply logging failed" };
  }

  // A staff reply answers the thread → clear the unread counter, mark outbound.
  await bumpThread(threadId, "outbound", previewOf(body), { clearUnread: true });
  return { message: inserted as unknown as EmailMessageRow, error: null };
}
