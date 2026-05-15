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

const app = new Hono();

// ─── Global middleware ───────────────────────────────────────────────
app.use("/*", cors());
app.use("/*", logger());
app.onError(errorHandler);

// ─── Health check ────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "Blink API",
    version: "1.0.0",
    status: "running",
  })
);

app.get("/health", (c) => c.json({ status: "ok" }));

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

// ─── Start server ────────────────────────────────────────────────────
console.log(`Blink API running on http://localhost:${env.PORT}`);

serve({
  fetch: app.fetch,
  port: env.PORT,
});

export default app;
