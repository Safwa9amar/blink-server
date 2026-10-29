import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Defined here (not enums.ts) so they ship in the additive `alerts` migration
// rather than the baseline snapshot. The metric is the server-health/traffic/ai
// signal the rule watches; the evaluator (src/lib/alerts.ts) maps each to a number.
export const alertMetric = pgEnum("alert_metric", [
  "error_rate", // metrics.errorRatePct
  "avg_latency", // metrics.avgLatencyMs
  "cpu", // metrics.cpuPct
  "memory", // heapUsed / heapTotal %
  "event_loop_lag", // metrics.eventLoopLagMs
  "req_per_min", // metrics.reqPerMin
  "ai_limit_hits", // aiMetrics.limitHits
]);
export const alertComparator = pgEnum("alert_comparator", ["gt", "gte", "lt", "lte"]);
export const alertSeverity = pgEnum("alert_severity", ["critical", "warning", "info"]);

// Blink Server → Alerts. A super-admin-authored threshold rule. The evaluator polls
// the live metrics and, when `metric <comparator> threshold` holds, opens an
// alert_event (and closes it when it clears). Admin-only: reads/writes go through the
// service role (dashboard createAdminClient / server supabaseAdmin); RLS denies the
// anon key, with a staff backstop policy.
export const alertRules = pgTable(
  "alert_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    metric: alertMetric("metric").notNull(),
    comparator: alertComparator("comparator").notNull().default("gt"),
    threshold: doublePrecision("threshold").notNull(),
    severity: alertSeverity("severity").notNull().default("warning"),
    enabled: boolean("enabled").notNull().default(true),
    // Delivery channels, e.g. ["inapp"], later ["inapp","email","whatsapp"].
    channels: text("channels").array().notNull().default(["inapp"]),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("idx_alert_rules_enabled")
      .on(t.enabled)
      .where(sql`enabled`),
    // Staff-only backstop; service-role bypasses RLS for the actual CRUD/evaluator.
    pgPolicy("alert_rules_staff_all", {
      for: "all",
      using: sql`EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);
