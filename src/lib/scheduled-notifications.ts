import cron from "node-cron";
import type { NotificationCopy, NotificationRow, UserRole } from "../db";
import { supabaseAdmin } from "./supabase";
import { broadcastNotification } from "./notifications";

// Shape as supabase-js actually returns it: SNAKE_CASE columns (supabase-js does
// NOT camelize like Drizzle's inferred types). Reading the Drizzle camelCase
// names off this object yields undefined — the trap that silently sent 0
// recipients before. Type the runtime row explicitly to keep them honest.
interface DueRow {
  id: string;
  type: NotificationRow["type"];
  title: string;
  description: string;
  href: string | null;
  content_eng: NotificationCopy | null;
  content_fr: NotificationCopy | null;
  content_ar: NotificationCopy | null;
  target_roles: string[] | null;
  channels: string[] | null;
  created_by: string | null;
}

// Fires due scheduled broadcasts. Driven by the cron endpoint
// (POST /cron/scheduled-notifications) every minute — and, on an always-on host,
// the optional in-process poller below. Each due row is CLAIMED atomically
// (pending → sending via a filtered update) so two overlapping runs can never
// double-send the same broadcast.

export interface ProcessResult {
  processed: number;
  sent: number;
  failed: number;
}

export async function processDueScheduledNotifications(
  limit = 50
): Promise<ProcessResult> {
  const nowIso = new Date().toISOString();

  // 1. Find rows whose time has come.
  const { data: due, error } = await supabaseAdmin
    .from("scheduled_notifications")
    .select("id")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[scheduled-notif] due query failed", error.message);
    return { processed: 0, sent: 0, failed: 0 };
  }
  if (!due || due.length === 0) return { processed: 0, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const { id } of due as { id: string }[]) {
    // 2. Atomically claim it: pending → sending. The status filter means only
    //    one runner wins; a row already grabbed returns no data and is skipped.
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("scheduled_notifications")
      .update({ status: "sending" })
      .eq("id", id)
      .eq("status", "pending")
      .select()
      .single();
    if (claimErr || !claimed) continue;

    const row = claimed as DueRow;
    try {
      // 3. Fan out via the shared delivery path. Audience is resolved fresh now
      //    (broadcastNotification looks up users by role at this moment).
      const pushOn = Array.isArray(row.channels)
        ? row.channels.includes("push")
        : true;
      const recipients = await broadcastNotification(
        (row.target_roles ?? []) as UserRole[],
        {
          type: row.type,
          title: row.title,
          description: row.description,
          href: row.href,
          contentEng: row.content_eng,
          contentFr: row.content_fr,
          contentAr: row.content_ar,
          createdBy: row.created_by,
          push: pushOn,
        }
      );

      await supabaseAdmin
        .from("scheduled_notifications")
        .update({
          status: "sent",
          recipients,
          pushed: pushOn ? recipients : 0,
          sent_at: new Date().toISOString(),
          error: null,
        })
        .eq("id", id);
      sent++;
    } catch (e) {
      const msg = (e as Error).message ?? "send failed";
      console.error("[scheduled-notif] send failed", id, msg);
      await supabaseAdmin
        .from("scheduled_notifications")
        .update({ status: "failed", error: msg })
        .eq("id", id);
      failed++;
    }
  }

  return { processed: due.length, sent, failed };
}

// In-process poller (every minute). KEEP OFF on cPanel/Passenger — the app is
// spun down when idle so this never fires reliably; drive it from a cPanel Cron
// Job hitting POST /cron/scheduled-notifications instead. Gated by
// ENABLE_INPROCESS_CRON, same as the library scraper.
export function startScheduledNotificationsCron() {
  cron.schedule("* * * * *", async () => {
    try {
      const r = await processDueScheduledNotifications();
      if (r.processed)
        console.log(
          `[scheduled-notif] processed ${r.processed} (sent ${r.sent}, failed ${r.failed})`
        );
    } catch (err) {
      console.error("[scheduled-notif] poller error", (err as Error).message);
    }
  });
  console.log("[cron] scheduled-notifications poller scheduled: every minute");
}
