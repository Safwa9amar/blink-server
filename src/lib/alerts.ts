// Blink Server → Alerts evaluator. Polls the live metrics each minute, opens an
// alert_event when a rule's threshold is crossed and resolves it when it clears
// (at most one open event per rule). Reads/writes via the service role (supabaseAdmin).
//
// Delivery: the alert_events row IS the in-app surface for staff (the dashboard Alerts
// tab reads it), plus a severity-tagged console line that shows up in the Live Logs
// tail. Email / WhatsApp are staged — logged as stubs until those channels are wired.
//
// HOSTING NOTE: on cPanel/Passenger idle processes spin down, so the in-process
// scheduler is unreliable in production — drive POST /cron/alerts from a cPanel Cron
// Job instead (see routes/cron). startAlertsEvaluator() is gated by ENABLE_INPROCESS_CRON.
import cron from "node-cron";
import { supabaseAdmin } from "./supabase";
import { getMetrics, type MetricsSnapshot } from "./metrics";
import { getAiMetrics } from "./ai-log";
import type { AlertComparator, AlertMetric, AlertSeverity } from "../db";

const COMP_LABEL: Record<AlertComparator, string> = { gt: ">", gte: "≥", lt: "<", lte: "≤" };
const METRIC_LABEL: Record<AlertMetric, string> = {
  error_rate: "error rate",
  avg_latency: "avg latency",
  cpu: "CPU",
  memory: "memory",
  event_loop_lag: "event-loop lag",
  req_per_min: "req/min",
  ai_limit_hits: "AI limit hits",
};
const METRIC_UNIT: Record<AlertMetric, string> = {
  error_rate: "%",
  avg_latency: "ms",
  cpu: "%",
  memory: "%",
  event_loop_lag: "ms",
  req_per_min: "",
  ai_limit_hits: "",
};

function metricValue(metric: AlertMetric, m: MetricsSnapshot, aiLimitHits: number): number {
  switch (metric) {
    case "error_rate":
      return m.errorRatePct;
    case "avg_latency":
      return m.avgLatencyMs;
    case "cpu":
      return m.cpuPct;
    case "memory":
      return m.heapTotal > 0 ? Math.round((m.heapUsed / m.heapTotal) * 100) : 0;
    case "event_loop_lag":
      return m.eventLoopLagMs;
    case "req_per_min":
      return m.reqPerMin;
    case "ai_limit_hits":
      return aiLimitHits;
  }
  return 0;
}

function crosses(value: number, comparator: AlertComparator, threshold: number): boolean {
  switch (comparator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
  }
  return false;
}

interface RuleRow {
  id: string;
  name: string;
  metric: AlertMetric;
  comparator: AlertComparator;
  threshold: number;
  severity: AlertSeverity;
  channels: string[];
}

export interface AlertEvalResult {
  evaluated: number;
  opened: number;
  resolved: number;
}

/** Evaluate all enabled rules against the current metrics. Idempotent. */
export async function evaluateAlerts(): Promise<AlertEvalResult> {
  const { data: rules, error } = await supabaseAdmin
    .from("alert_rules")
    .select("id,name,metric,comparator,threshold,severity,channels")
    .eq("enabled", true);
  if (error) {
    console.error("[alerts] failed to load rules:", error.message);
    return { evaluated: 0, opened: 0, resolved: 0 };
  }

  const snap = getMetrics();
  const aiLimitHits = getAiMetrics().limitHits;
  let opened = 0;
  let resolved = 0;

  for (const rule of (rules ?? []) as RuleRow[]) {
    const value = metricValue(rule.metric, snap, aiLimitHits);
    const firing = crosses(value, rule.comparator, rule.threshold);

    const { data: active } = await supabaseAdmin
      .from("alert_events")
      .select("id")
      .eq("rule_id", rule.id)
      .eq("status", "active")
      .maybeSingle();

    if (firing && !active) {
      const unit = METRIC_UNIT[rule.metric];
      const message = `${METRIC_LABEL[rule.metric]} ${COMP_LABEL[rule.comparator]} ${rule.threshold}${unit} (now ${value}${unit})`;
      const { error: insErr } = await supabaseAdmin
        .from("alert_events")
        .insert({ rule_id: rule.id, status: "active", severity: rule.severity, value, message });
      if (!insErr) {
        opened++;
        notify(rule, message);
      }
    } else if (!firing && active) {
      const { error: updErr } = await supabaseAdmin
        .from("alert_events")
        .update({ status: "resolved", resolved_at: new Date().toISOString() })
        .eq("id", (active as { id: string }).id);
      if (!updErr) {
        resolved++;
        console.log(`[alerts] resolved: ${rule.name}`);
      }
    }
  }

  return { evaluated: rules?.length ?? 0, opened, resolved };
}

function notify(rule: RuleRow, message: string): void {
  const line = `[alerts] ${rule.severity.toUpperCase()} "${rule.name}" fired — ${message}`;
  if (rule.severity === "critical") console.error(line);
  else if (rule.severity === "warning") console.warn(line);
  else console.log(line);
  for (const ch of rule.channels) {
    if (ch !== "inapp") console.log(`[alerts] (stub) would deliver "${rule.name}" via ${ch}`);
  }
}

/** Start the in-process minute scheduler (idempotent; gated by ENABLE_INPROCESS_CRON). */
export function startAlertsEvaluator(): void {
  cron.schedule("* * * * *", async () => {
    try {
      const r = await evaluateAlerts();
      if (r.opened || r.resolved) {
        console.log(`[alerts] opened ${r.opened}, resolved ${r.resolved} (evaluated ${r.evaluated})`);
      }
    } catch (err) {
      console.error("[alerts] evaluator error", (err as Error).message);
    }
  });
  console.log("[cron] alerts evaluator scheduled: every minute");
}
