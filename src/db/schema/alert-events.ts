import { sql } from "drizzle-orm";
import { doublePrecision, index, pgEnum, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alertRules, alertSeverity } from "./alert-rules";

export const alertEventStatus = pgEnum("alert_event_status", ["active", "resolved"]);

// Blink Server → Alerts history. One row per time a rule's condition opened; the
// evaluator resolves it (sets resolved_at + status) when the metric clears. At most
// one "active" event per rule at a time. Admin-only (service role + staff backstop).
export const alertEvents = pgTable(
  "alert_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => alertRules.id, { onDelete: "cascade" }),
    status: alertEventStatus("status").notNull().default("active"),
    // Snapshot of the rule severity + the metric value at fire time, so history
    // stays meaningful even if the rule is later edited or deleted.
    severity: alertSeverity("severity").notNull(),
    value: doublePrecision("value").notNull(),
    message: text("message"),
    firedAt: timestamp("fired_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    index("idx_alert_events_rule").on(t.ruleId),
    index("idx_alert_events_fired").on(t.firedAt),
    // Fast lookup of a rule's currently-open event (the evaluator's hot path).
    index("idx_alert_events_active")
      .on(t.ruleId)
      .where(sql`status = 'active'`),
    pgPolicy("alert_events_staff_all", {
      for: "all",
      using: sql`EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL)`,
    }),
  ]
);
