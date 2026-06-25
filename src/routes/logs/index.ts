import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import { getLogs, clearLogs } from "../../lib/log-buffer";

// Super-admin-only live server logs — the dashboard's Blink Server → Live Logs
// view polls these. An in-memory ring buffer of recent console output (see
// lib/log-buffer.ts); nothing is persisted.
//
//   GET    /logs?since=<id>  → { logs, lastId }  (incremental tail)
//   DELETE /logs             → clears the buffer
//
// Logs can surface internal detail, so this is tighter than the other admin
// routes: auth + staff + an explicit super_admin check.
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
  const logs = getLogs(since);
  const lastId = logs.length ? logs[logs.length - 1].id : since;
  return c.json({ logs, lastId });
});

app.delete("/", (c) => {
  clearLogs();
  return c.json({ ok: true });
});

export default app;
