import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import { env } from "../../config/env";
import { supabaseAdmin } from "../supabase";
import { matchUserByEmail, normalizeSubject, previewOf } from "./shared";
import type { EmailDirection } from "../../db";

// Polls the configured IMAP mailbox for UNSEEN mail, threads each message, and
// stores it as an inbound row. Driven by POST /cron/email-poll (a cPanel Cron
// Job) — Passenger spins the app down when idle, so in-process polling is
// unreliable. Idempotent: a stored RFC Message-ID is never inserted twice
// (unique index + an up-front check), and every processed message is flagged
// \Seen so the next poll skips it.

export interface PollResult {
  ok: boolean;
  reason?: string;
  fetched: number;
  inserted: number;
  threads: number;
}

interface ThreadRef {
  id: string;
  status: string;
}

export async function pollEmailInbox(): Promise<PollResult> {
  if (!env.IMAP_HOST || !env.IMAP_USER || !env.IMAP_PASS) {
    return { ok: false, reason: "IMAP not configured", fetched: 0, inserted: 0, threads: 0 };
  }

  const client = new ImapFlow({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    secure: env.IMAP_SECURE,
    auth: { user: env.IMAP_USER, pass: env.IMAP_PASS },
    logger: false,
  });

  let fetched = 0;
  let inserted = 0;
  const touched = new Set<string>();

  try {
    await client.connect();
    const lock = await client.getMailboxLock(env.IMAP_MAILBOX);
    try {
      // `{ seen: false }` is an IMAP search for UNSEEN messages.
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true })) {
        fetched++;
        try {
          const parsed = await simpleParser(msg.source as Buffer);
          const res = await ingestInbound(parsed);
          if (res.inserted) inserted++;
          if (res.threadId) touched.add(res.threadId);
        } catch (e) {
          console.error("[email] ingest failed", (e as Error).message);
        }
        // Backstop idempotency: mark \Seen so re-polls skip it.
        try {
          await client.messageFlagsAdd(String(msg.uid), ["\\Seen"], { uid: true });
        } catch (e) {
          console.error("[email] flag \\Seen failed", (e as Error).message);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error("[email] poll failed", (e as Error).message);
    return { ok: false, reason: (e as Error).message, fetched, inserted, threads: touched.size };
  } finally {
    try {
      await client.logout();
    } catch {
      /* connection may already be gone */
    }
  }

  if (fetched) {
    console.log(`[email] polled ${fetched} (inserted ${inserted}, threads ${touched.size})`);
  }
  return { ok: true, fetched, inserted, threads: touched.size };
}

// Store one parsed inbound email, resolving/creating its thread first.
async function ingestInbound(
  parsed: ParsedMail
): Promise<{ inserted: boolean; threadId: string | null }> {
  const messageId = parsed.messageId ?? null;

  // Already stored? (checked before insert too via the unique index).
  if (messageId) {
    const { data: existing } = await supabaseAdmin
      .from("email_messages")
      .select("thread_id")
      .eq("message_id", messageId)
      .limit(1)
      .maybeSingle();
    if (existing) return { inserted: false, threadId: (existing as { thread_id: string }).thread_id };
  }

  const fromAddr = firstAddress(parsed.from)?.address?.toLowerCase() ?? "unknown@unknown";
  const fromName = firstAddress(parsed.from)?.name || null;
  const toAddr = env.IMAP_USER ?? firstAddress(parsed.to)?.address ?? "";
  const subject = parsed.subject ?? null;
  const bodyText = parsed.text ?? "";
  const bodyHtml = typeof parsed.html === "string" ? parsed.html : null;
  const inReplyTo = parsed.inReplyTo ?? refsLast(parsed.references) ?? null;

  const thread = await resolveThread({ fromAddr, fromName, subject, inReplyTo });

  const attachments = (parsed.attachments ?? []).map((a) => ({
    filename: a.filename ?? null,
    contentType: a.contentType ?? null,
    size: a.size ?? null,
  }));

  const { error: insErr } = await supabaseAdmin.from("email_messages").insert({
    thread_id: thread.id,
    direction: "inbound",
    message_id: messageId,
    in_reply_to: inReplyTo,
    from_email: fromAddr,
    from_name: fromName,
    to_email: toAddr,
    subject,
    body_text: bodyText,
    body_html: bodyHtml,
    sender_id: null,
    meta: attachments.length ? { attachments } : null,
  });
  if (insErr) {
    // 23505 = unique_violation on message_id — a concurrent poll won the race.
    if ((insErr as { code?: string }).code === "23505") {
      return { inserted: false, threadId: thread.id };
    }
    throw new Error(insErr.message);
  }

  await bumpThread(thread.id, "inbound", previewOf(bodyText || subject || ""), {
    reopen: thread.status === "closed",
    incUnread: true,
  });
  return { inserted: true, threadId: thread.id };
}

// Find the thread this inbound belongs to: (1) it replies to a stored message,
// (2) same sender + normalized subject, else (3) a fresh thread.
async function resolveThread(args: {
  fromAddr: string;
  fromName: string | null;
  subject: string | null;
  inReplyTo: string | null;
}): Promise<ThreadRef> {
  const { fromAddr, fromName, subject, inReplyTo } = args;

  if (inReplyTo) {
    const { data: parentMsg } = await supabaseAdmin
      .from("email_messages")
      .select("thread_id")
      .eq("message_id", inReplyTo)
      .limit(1)
      .maybeSingle();
    if (parentMsg) {
      const t = await getThread((parentMsg as { thread_id: string }).thread_id);
      if (t) return t;
    }
  }

  const norm = normalizeSubject(subject);
  if (norm) {
    const { data: match } = await supabaseAdmin
      .from("email_threads")
      .select("id, status")
      .eq("customer_email", fromAddr)
      .eq("normalized_subject", norm)
      .order("last_message_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (match) return match as ThreadRef;
  }

  const userId = await matchUserByEmail(fromAddr);
  const { data: created, error } = await supabaseAdmin
    .from("email_threads")
    .insert({
      customer_email: fromAddr,
      customer_name: fromName,
      user_id: userId,
      subject,
      normalized_subject: norm,
      status: "open",
      last_direction: "inbound",
    })
    .select("id, status")
    .single();
  if (error || !created) throw new Error(error?.message ?? "thread create failed");
  return created as ThreadRef;
}

async function getThread(id: string): Promise<ThreadRef | null> {
  const { data } = await supabaseAdmin
    .from("email_threads")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  return (data as ThreadRef | null) ?? null;
}

// Refresh a thread's inbox-list fields after a message lands. `message_count` is
// recounted (low volume; avoids an atomic-increment RPC). Shared by the SMTP
// reply path in ./smtp.ts.
export async function bumpThread(
  threadId: string,
  direction: EmailDirection,
  preview: string,
  opts?: { reopen?: boolean; incUnread?: boolean; clearUnread?: boolean }
): Promise<void> {
  const { count } = await supabaseAdmin
    .from("email_messages")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId);

  const patch: Record<string, unknown> = {
    last_message_at: new Date().toISOString(),
    last_message_preview: preview,
    last_direction: direction,
    message_count: count ?? 0,
  };
  if (opts?.reopen) patch.status = "open";
  if (opts?.clearUnread) {
    patch.unread_for_staff = 0;
  } else if (opts?.incUnread) {
    const { data } = await supabaseAdmin
      .from("email_threads")
      .select("unread_for_staff")
      .eq("id", threadId)
      .maybeSingle();
    patch.unread_for_staff = ((data as { unread_for_staff: number } | null)?.unread_for_staff ?? 0) + 1;
  }
  await supabaseAdmin.from("email_threads").update(patch).eq("id", threadId);
}

// First address of a From/To header, tolerating mailparser's single-or-array
// AddressObject shape.
function firstAddress(
  field: AddressObject | AddressObject[] | undefined
): { address?: string; name?: string } | undefined {
  if (!field) return undefined;
  const obj = Array.isArray(field) ? field[0] : field;
  return obj?.value?.[0];
}

// The last entry of a References header (string or array form).
function refsLast(refs: string | string[] | undefined): string | null {
  if (!refs) return null;
  if (Array.isArray(refs)) return refs[refs.length - 1] ?? null;
  const parts = refs.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? null;
}
