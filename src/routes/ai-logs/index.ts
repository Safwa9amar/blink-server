import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import { getAiLogs, clearAiLogs } from "../../lib/ai-log";

// Super-admin-only live AI-call log — the dashboard's Blink Server → AI Log view
// polls these. An in-memory ring buffer of recent AI provider calls: successful
// replies (with token usage) and failures, including the "model reached its limit"
// case (HTTP 429 rate-limit / 402 out-of-credits). See lib/ai-log.ts. Nothing is
// persisted — it's a live tail of the last entries.
//
//   GET    /ai-logs?since=<id>  → { logs, lastId }  (incremental tail)
//   DELETE /ai-logs             → clears the buffer
//
// Logs can surface internal detail (prompts, errors), so this is gated tighter
// than the other admin routes: auth + staff + an explicit super_admin check —
// same as /logs.
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

app.get("/", (c) => {
  const since = Number(c.req.query("since")) || 0;
  const logs = getAiLogs(since);
  const lastId = logs.length ? logs[logs.length - 1].id : since;
  return c.json({ logs, lastId });
});

app.delete("/", (c) => {
  clearAiLogs();
  return c.json({ ok: true });
});

export default app;
