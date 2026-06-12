import { Hono } from "hono";
import { requireCronSecret } from "../library/shared";
import { processDueScheduledNotifications } from "../../lib/scheduled-notifications";

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

export default app;
