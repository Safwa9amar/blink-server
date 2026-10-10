import { Hono, type Context } from "hono";
import { requireCronSecret } from "../library/shared";
import { processDueScheduledNotifications } from "../../lib/scheduled-notifications";
import { processNewsCron } from "../../lib/news-cron";
import { evaluateAlerts } from "../../lib/alerts";
import { pollEmailInbox } from "../../lib/email/imap";
import { runMerchantInsights } from "../merchant/strategy-shared";
import { processBundleTimeouts } from "../../lib/bundle-timeouts";
import { processSearchTimeouts } from "../../lib/search-timeouts";

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

// POST /cron/merchant-insights — weekly "Efficiency" nudges for every active
// store (idempotent per store/action/week). Wire hourly or daily:
//   0 9 * * * curl -sS -X POST https://blink.greenpedal.net/cron/merchant-insights -H "x-cron-secret: $CRON_SECRET"
app.post("/merchant-insights", requireCronSecret, async (c) => {
  const result = await runMerchantInsights();
  return c.json(result);
});

// POST /cron/bundle-timeouts — a store that hasn't answered a multi-store
// checkout order within 10 minutes hands it to a Blink shopper (same patch as a
// `too_busy` rejection), so the rest of the checkout isn't held up. It's
// idempotent because only `pending` orders are touched. Wire a cPanel Cron Job
// to hit this every minute:
//   * * * * * curl -sS -X POST https://blink.greenpedal.net/cron/bundle-timeouts -H "x-cron-secret: $CRON_SECRET"
app.post("/bundle-timeouts", requireCronSecret, async (c) => {
  const result = await processBundleTimeouts();
  return c.json(result);
});

// POST /cron/search-timeouts — a courier request no rider took within 20
// minutes of going live, or a ride within 10, is canceled (cancel_reason
// no_rider) and the customer is told, instead of searching forever.
// Idempotent (only unclaimed `searching` rows are touched). GET /orders and
// GET /orders/{id} also expire lazily. Wire a cPanel Cron Job to hit this
// every minute:
//   * * * * * curl -sS -X POST https://blink.greenpedal.net/cron/search-timeouts -H "x-cron-secret: $CRON_SECRET"
// POST /cron/courier-timeouts is the same job under its earlier name, so
// existing cron entries keep working.
const searchTimeouts = async (c: Context) => c.json(await processSearchTimeouts());
app.post("/search-timeouts", requireCronSecret, searchTimeouts);
app.post("/courier-timeouts", requireCronSecret, searchTimeouts);

export default app;
