import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { env } from "./config/env";
import { errorHandler } from "./middleware/error-handler";
import { mountDocs } from "./openapi";

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
import emailRoutes from "./routes/email";
import cronRoutes from "./routes/cron";
import supportChatRoutes from "./routes/support-chat";
import supportContentRoutes from "./routes/support-content";
import aiRoutes from "./routes/ai";
import logsRoutes from "./routes/logs";
import aiLogsRoutes from "./routes/ai-logs";
import metricsRoutes from "./routes/metrics";
import marketplaceRoutes from "./routes/marketplace";
import promotionRoutes from "./routes/promotions";
import couponRoutes from "./routes/coupons";
import favoriteRoutes from "./routes/favorites";
import merchantRoutes from "./routes/merchant";
import { metricsMiddleware } from "./middleware/metrics";

// __APP_VERSION__ is injected from package.json at build time by
// scripts/build.mjs (esbuild --define). Under `tsx` dev it is undefined, so
// fall back to "dev". The deploy script bumps package.json on every deploy.
declare const __APP_VERSION__: string | undefined;
export const VERSION =
  typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";

// BASE_PATH lets the same build serve at a domain root (dev) or under a
// sub-path like greenpedal.net/blink (cPanel). Empty string = root.
const app = new OpenAPIHono().basePath(env.BASE_PATH);

// ─── Global middleware ───────────────────────────────────────────────
app.use("/*", cors());
app.use("/*", logger());
// Time every request into the rolling metrics window (Blink Server → Health).
app.use("/*", metricsMiddleware);
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
app.route("/marketplace", marketplaceRoutes);
app.route("/promotions", promotionRoutes);
app.route("/coupons", couponRoutes);
app.route("/favorites", favoriteRoutes);
app.route("/merchant", merchantRoutes);
app.route("/earnings", earningsRoutes);
app.route("/agents", agentRoutes);
app.route("/riders", riderRoutes);
app.route("/news", newsRoutes);
app.route("/support-chat", supportChatRoutes);
app.route("/support-content", supportContentRoutes);
app.route("/ai", aiRoutes);
app.route("/logs", logsRoutes);
app.route("/ai-logs", aiLogsRoutes);
app.route("/metrics", metricsRoutes);
app.route("/deep-links", deepLinkRoutes);
app.route("/library", libraryRoutes);
app.route("/email", emailRoutes);
app.route("/cron", cronRoutes);

// ─── OpenAPI spec (consumed by the mobile app's orval client) ────────
mountDocs(app, VERSION);

export default app;
