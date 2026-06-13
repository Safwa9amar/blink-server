import cron from "node-cron";
import type { NewsCopy, UserRole } from "../db";
import { supabaseAdmin } from "./supabase";
import { broadcastNotification } from "./notifications";

// Drives the three news-publishing behaviours the dashboard composer exposes but
// that previously did nothing: scheduled publishing, the "Send push" toggle, and
// auto-unpublish. Called by POST /cron/news every minute (and the optional
// in-process poller). All steps are best-effort and idempotent.

// news.target_roles use CAPITALIZED dashboard labels (["All","Rider",…]) — unlike
// the lowercase user_role enum broadcastNotification expects. Map them.
const LABEL_TO_ENUM: Record<string, UserRole> = {
  Customer: "customer",
  Rider: "rider",
  Merchant: "merchant",
  Agent: "agent",
};
const ALL_ROLES: UserRole[] = ["customer", "rider", "merchant", "agent"];

function newsRolesToEnum(roles: string[] | null): UserRole[] {
  if (!roles || roles.length === 0 || roles.includes("All")) return ALL_ROLES;
  return [...new Set(roles.map((r) => LABEL_TO_ENUM[r]).filter(Boolean))];
}

// News copy ({ title, sum, body }) → a notification's { title, description }.
function toNotifCopy(c: NewsCopy | null): { title: string; description: string } | null {
  if (!c) return null;
  return { title: c.title, description: c.sum };
}

interface PushRow {
  id: string;
  target_roles: string[] | null;
  content_eng: NewsCopy | null;
  content_fr: NewsCopy | null;
  content_ar: NewsCopy | null;
}

export interface NewsCronResult {
  published: number;
  pushed: number;
  unpublished: number;
}

export async function processNewsCron(): Promise<NewsCronResult> {
  const nowIso = new Date().toISOString();
  let published = 0;
  let pushed = 0;
  let unpublished = 0;

  // ── (a) Publish due scheduled posts ────────────────────────────────
  // After this they're `published` with push_sent_at NULL, so step (b) in the
  // SAME run delivers their push.
  {
    const { data, error } = await supabaseAdmin
      .from("news")
      .update({ status: "published", published_at: nowIso })
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso)
      .select("id");
    if (error) console.error("[news-cron] publish failed", error.message);
    else published = data?.length ?? 0;
  }

  // ── (b) Deliver the publish push for published, push-on, not-yet-pushed,
  //        non-expired posts ──────────────────────────────────────────
  {
    const { data: candidates, error } = await supabaseAdmin
      .from("news")
      .select("id, target_roles, content_eng, content_fr, content_ar")
      .eq("status", "published")
      .eq("push", true)
      .is("push_sent_at", null)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
      .limit(50);
    if (error) console.error("[news-cron] push query failed", error.message);

    for (const row of (candidates ?? []) as PushRow[]) {
      // Claim atomically (push_sent_at NULL → now) so overlapping runs can't
      // double-push. If another runner won, skip.
      const { data: claimed } = await supabaseAdmin
        .from("news")
        .update({ push_sent_at: nowIso })
        .eq("id", row.id)
        .is("push_sent_at", null)
        .select("id")
        .single();
      if (!claimed) continue;

      const title =
        row.content_eng?.title ||
        row.content_fr?.title ||
        row.content_ar?.title ||
        "Blink News";
      const description =
        row.content_eng?.sum || row.content_fr?.sum || row.content_ar?.sum || "";

      try {
        await broadcastNotification(newsRolesToEnum(row.target_roles), {
          type: "news",
          title,
          description,
          href: `/news/${row.id}`,
          contentEng: toNotifCopy(row.content_eng),
          contentFr: toNotifCopy(row.content_fr),
          contentAr: toNotifCopy(row.content_ar),
          push: true,
        });
        pushed++;
      } catch (e) {
        // Already marked push_sent_at; the in-app notification is best-effort.
        console.error("[news-cron] push failed", row.id, (e as Error).message);
      }
    }
  }

  // ── (c) Auto-unpublish expired posts ───────────────────────────────
  {
    const { data, error } = await supabaseAdmin
      .from("news")
      .update({ status: "draft" })
      .eq("status", "published")
      .not("expires_at", "is", null)
      .lte("expires_at", nowIso)
      .select("id");
    if (error) console.error("[news-cron] unpublish failed", error.message);
    else unpublished = data?.length ?? 0;
  }

  return { published, pushed, unpublished };
}

// In-process poller (every minute). KEEP OFF on cPanel/Passenger (idle spin-down)
// — driven by a cPanel Cron Job hitting POST /cron/news instead. Gated by
// ENABLE_INPROCESS_CRON.
export function startNewsCron() {
  cron.schedule("* * * * *", async () => {
    try {
      const r = await processNewsCron();
      if (r.published || r.pushed || r.unpublished)
        console.log(
          `[news-cron] published ${r.published}, pushed ${r.pushed}, unpublished ${r.unpublished}`
        );
    } catch (err) {
      console.error("[news-cron] poller error", (err as Error).message);
    }
  });
  console.log("[cron] news poller scheduled: every minute");
}
