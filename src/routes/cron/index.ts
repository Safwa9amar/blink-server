import { Hono } from "hono";
import { requireCronSecret } from "../library/shared";
import { processDueScheduledNotifications } from "../../lib/scheduled-notifications";
import { processNewsCron } from "../../lib/news-cron";
import { evaluateAlerts } from "../../lib/alerts";
import { pollEmailInbox } from "../../lib/email/imap";

// External cron entrypoints. NOT behind `auth` (a cron caller has no JWT) —
// guarded by CRON_SECRET via the `x-cron-secret` header instead. Driven by
// cPanel Cron Jobs (Passenger spins down idle, so in-process node-cron is
// unreliable in production).
const app = new Hono();

// POST /cron/scheduled-notifications — fire every scheduled broadcast whose time
// has come. Idempotent + safe to overlap (rows are claimed atomically). Wire a
// cPanel Cron Job to hit this every minute:
//   * * * * * curl -sS -X POST https://blink.greenpedal.net/cron/scheduled-notifications -H "x-cron-secret: $CRON_SECRET"
app.post("/scheduled-notifications", requireCronSecret, async (c) => {
  const result = await processDueScheduledNotifications();
  return c.json(result);
});

// POST /cron/news — publish due scheduled posts, deliver publish-pushes, and
// auto-unpublish expired ones. Wire a cPanel Cron Job to hit this every minute:
//   * * * * * curl -sS -X POST https://blink.greenpedal.net/cron/news -H "x-cron-secret: $CRON_SECRET"
app.post("/news", requireCronSecret, async (c) => {
  const result = await processNewsCron();
  return c.json(result);
});

// POST /cron/alerts — evaluate alert rules against live metrics, open/resolve events.
// Wire a cPanel Cron Job to hit this every minute:
//   * * * * * curl -sS -X POST https://blink.greenpedal.net/cron/alerts -H "x-cron-secret: $CRON_SECRET"
app.post("/alerts", requireCronSecret, async (c) => {
  const result = await evaluateAlerts();
  return c.json(result);
});

// POST /cron/email-poll — pull UNSEEN customer mail from the IMAP mailbox into
// email_threads / email_messages. Idempotent (unique Message-ID + \Seen flag),
// so overlapping runs are safe. No-ops when IMAP isn't configured. Wire a cPanel
// Cron Job to hit this every couple of minutes:
//   */2 * * * * curl -sS -X POST https://blink.greenpedal.net/cron/email-poll -H "x-cron-secret: $CRON_SECRET"
app.post("/email-poll", requireCronSecret, async (c) => {
  const result = await pollEmailInbox();
  return c.json(result);
});

export default app;
