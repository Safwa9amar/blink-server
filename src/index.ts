import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env";
import { errorHandler } from "./middleware/error-handler";

import authRoutes from "./routes/auth";
import tripRoutes from "./routes/trips";
import transactionRoutes from "./routes/transactions";
import orderRoutes from "./routes/orders";
import notificationRoutes from "./routes/notifications";
import addressRoutes from "./routes/addresses";
import earningsRoutes from "./routes/earnings";
import agentRoutes from "./routes/agents";
import riderRoutes from "./routes/riders";
import newsRoutes from "./routes/news";
import deepLinkRoutes from "./routes/deep-links";
import libraryRoutes from "./routes/library";
import cronRoutes from "./routes/cron";
import { startLibraryCron } from "./scrapers/cron";
import { startScheduledNotificationsCron } from "./lib/scheduled-notifications";

// __APP_VERSION__ is injected from package.json at build time by
// scripts/build.mjs (esbuild --define). Under `tsx` dev it is undefined, so
// fall back to "dev". The deploy script bumps package.json on every deploy.
declare const __APP_VERSION__: string | undefined;
const VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

// BASE_PATH lets the same build serve at a domain root (dev) or under a
// sub-path like greenpedal.net/blink (cPanel). Empty string = root.
const app = new Hono().basePath(env.BASE_PATH);

// ─── Global middleware ───────────────────────────────────────────────
app.use("/*", cors());
app.use("/*", logger());
app.onError(errorHandler);

// ─── Health check ────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "Blink API",
    version: VERSION,
    status: "running",
  })
);

app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

// ─── Routes ──────────────────────────────────────────────────────────
app.route("/auth", authRoutes);
app.route("/trips", tripRoutes);
app.route("/transactions", transactionRoutes);
app.route("/orders", orderRoutes);
app.route("/notifications", notificationRoutes);
app.route("/addresses", addressRoutes);
app.route("/earnings", earningsRoutes);
app.route("/agents", agentRoutes);
app.route("/riders", riderRoutes);
app.route("/news", newsRoutes);
app.route("/deep-links", deepLinkRoutes);
app.route("/library", libraryRoutes);
app.route("/cron", cronRoutes);

// ─── Cron: scrape marketplaces daily at 3am ─────────────────────────
// On cPanel/Passenger the app is spun down when idle, so in-process cron
// never fires reliably — keep this OFF in production and drive scrapes from a
// cPanel Cron Job hitting POST /library/scrape instead. Toggle with
// ENABLE_INPROCESS_CRON=true only on an always-on host.
if (env.ENABLE_INPROCESS_CRON) {
  startLibraryCron();
  startScheduledNotificationsCron();
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

export default app;
