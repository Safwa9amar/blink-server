// In-memory ring buffer of recent server console output, exposed to super admins
// via GET /logs (the dashboard's "Blink Server → Live Logs" view). The server runs
// as a single cPanel/Passenger process, so a module-level buffer captures the whole
// picture. Nothing is persisted — it's a live tail of the last MAX entries.

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  id: number; // monotonic, lets the dashboard poll incrementally (?since=)
  ts: string; // ISO timestamp
  level: LogLevel;
  source: string; // "console" (captured) or a custom tag
  msg: string;
}

const MAX = 500;
const buffer: LogEntry[] = [];
let seq = 0;

export function pushLog(level: LogLevel, source: string, msg: string): void {
  seq += 1;
  buffer.push({ id: seq, ts: new Date().toISOString(), level, source, msg });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
}

/** Entries newer than `sinceId` (0 = everything buffered), capped at `limit`. */
export function getLogs(sinceId = 0, limit = 300): LogEntry[] {
  const fresh = sinceId > 0 ? buffer.filter((e) => e.id > sinceId) : buffer.slice();
  return fresh.slice(-limit);
}

export function clearLogs(): void {
  buffer.length = 0;
}

// Roughly how Node's console renders mixed args, for the buffered string.
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

// The dashboard polls GET /logs every few seconds; hono/logger prints a request
// line for each. Skip those so the live tail isn't dominated by its own polling.
const SELF_POLL_RE = /(<--|-->)\s+(GET|DELETE)\s+\/logs\b/;

let installed = false;
let capturing = false; // re-entrancy guard (formatting/push must never re-enter)

/**
 * Mirror console.{log,info,warn,error} into the ring buffer (while still calling
 * the original). This captures everything the server prints — request lines
 * (hono/logger), cron output, support-bot turns, errors — so the dashboard shows a
 * live tail of actual server activity without instrumenting every call site.
 */
export function installConsoleCapture(): void {
  if (installed) return;
  installed = true;
  const levels: [keyof Console, LogLevel][] = [
    ["log", "info"],
    ["info", "info"],
    ["warn", "warn"],
    ["error", "error"],
  ];
  for (const [method, level] of levels) {
    const orig = (console[method] as (...a: unknown[]) => void).bind(console);
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      orig(...args);
      if (capturing) return;
      capturing = true;
      try {
        const text = fmt(args);
        if (!SELF_POLL_RE.test(text)) pushLog(level, "console", text);
      } catch {
        /* never let logging break the app */
      } finally {
        capturing = false;
      }
    };
  }
}
