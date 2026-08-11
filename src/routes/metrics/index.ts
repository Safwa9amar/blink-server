import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import { getMetrics, getTraffic } from "../../lib/metrics";
import { getAiMetrics } from "../../lib/ai-log";

// Super-admin-only server vitals — the dashboard's Blink Server → Health view polls
// these. An in-memory snapshot of process + request metrics (see lib/metrics.ts);
// nothing is persisted. Same tight gating as /logs: auth + staff + super_admin.
//
//   GET /metrics → { metrics }
const app = new Hono<AuthEnv>();

const requireSuperAdmin = createMiddleware<AuthEnv>(async (c, next) => {
  if (c.get("user").staff_role !== "super_admin") {
    return c.json({ error: "Access denied. Super admin only." }, 403);
  }
  await next();
});

app.use("/*", auth);
app.use("/*", requireStaff());
app.use("/*", requireSuperAdmin);

app.get("/", (c) => c.json({ metrics: getMetrics() }));

// Traffic analytics over a selectable window (Blink Server → Traffic).
const RANGE_MIN: Record<string, number> = { "15m": 15, "1h": 60, "24h": 1440 };
app.get("/traffic", (c) => {
  const rangeMin = RANGE_MIN[c.req.query("range") ?? "1h"] ?? 60;
  return c.json({ traffic: getTraffic(rangeMin) });
});

// AI Insights — rollups over the buffered AI call log (Blink Server → AI Insights).
app.get("/ai", (c) => c.json({ aiMetrics: getAiMetrics() }));

export default app;
