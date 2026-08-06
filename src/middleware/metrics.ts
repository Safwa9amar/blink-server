import { createMiddleware } from "hono/factory";
import { routePath } from "hono/route";
import { performance } from "node:perf_hooks";
import { env } from "../config/env";
import { recordRequest } from "../lib/metrics";

function normalize(path: string): string {
  if (env.BASE_PATH && path.startsWith(env.BASE_PATH)) {
    return path.slice(env.BASE_PATH.length) || "/";
  }
  return path;
}

// Monitoring + self-poll + liveness endpoints, excluded so Health/Traffic reflect real
// app traffic rather than the dashboard watching itself — it polls /logs, /ai-logs,
// /metrics, /metrics/traffic and /metrics/ai every few seconds, /health on switch, and
// uptime probes hit "/". Matched on the base-path-normalized path: exact for the leaf
// endpoints (never under-counts an unrelated route ending in "logs"), plus the
// "/metrics/" prefix so the analytics sub-paths don't self-pollute the leaderboard.
function isMonitoring(path: string): boolean {
  return (
    path === "/" ||
    path === "/health" ||
    path === "/logs" ||
    path === "/ai-logs" ||
    path === "/metrics" ||
    path.startsWith("/metrics/")
  );
}

// Time every request and feed its status + duration into the rolling metrics window.
// Registered globally so it wraps all routes; reads c.res after next() resolves.
export const metricsMiddleware = createMiddleware(async (c, next) => {
  const start = performance.now();
  try {
    await next();
  } finally {
    // Record in finally so duration is captured even if a downstream handler throws
    // (onError still produces the response; we just observe c.res.status).
    const path = normalize(c.req.path);
    if (!isMonitoring(path)) {
      // Group by the matched route PATTERN (e.g. "/trips/:id"; "/*" for unmatched
      // 404s) — not the raw URL — so the endpoint roll-up can't be exploded or
      // polluted by per-id paths or scanner traffic.
      recordRequest(c.req.method, routePath(c), c.res.status, performance.now() - start);
    }
  }
});
