import { serve } from "@hono/node-server";
import { env } from "./config/env";
import app from "./app";
import { installConsoleCapture } from "./lib/log-buffer";
import { startMetrics } from "./lib/metrics";
import { startLibraryCron } from "./scrapers/cron";
import { startScheduledNotificationsCron } from "./lib/scheduled-notifications";
import { startNewsCron } from "./lib/news-cron";
import { startAlertsEvaluator } from "./lib/alerts";
import { startCourierTimeoutsCron } from "./lib/courier-timeouts";

// Mirror console output into an in-memory ring buffer (super-admin Live Logs view).
// Installed first so it captures everything the process prints from here on.
installConsoleCapture();

// Start the 1s vitals sampler (event-loop lag, CPU) for the super-admin Health view.
startMetrics();

// ─── Cron: scrape marketplaces daily at 3am ─────────────────────────
// On cPanel/Passenger the app is spun down when idle, so in-process cron
// never fires reliably — keep this OFF in production and drive scrapes from a
// cPanel Cron Job hitting POST /library/scrape instead. Toggle with
// ENABLE_INPROCESS_CRON=true only on an always-on host.
if (env.ENABLE_INPROCESS_CRON) {
  startLibraryCron();
  startScheduledNotificationsCron();
  startNewsCron();
  startAlertsEvaluator();
  startCourierTimeoutsCron();
} else {
  console.log(
    "[cron] in-process scheduler disabled (set ENABLE_INPROCESS_CRON=true to enable)"
  );
}

// ─── Start server ────────────────────────────────────────────────────
console.log(`Blink API running on http://localhost:${env.PORT}`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});

