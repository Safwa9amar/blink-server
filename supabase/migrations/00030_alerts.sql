-- =====================================================================
-- Blink Server — Alerts (threshold rules + fired events)
-- =====================================================================
-- Authored in Drizzle (src/db/schema/alert-rules.ts, alert-events.ts).
-- Admin-only: the dashboard (createAdminClient) and the server evaluator
-- (supabaseAdmin) use the service role, which bypasses RLS. RLS is enabled
-- as a deny-by-default backstop with a staff read/write policy.

CREATE TYPE "public"."alert_metric" AS ENUM('error_rate', 'avg_latency', 'cpu', 'memory', 'event_loop_lag', 'req_per_min', 'ai_limit_hits');
CREATE TYPE "public"."alert_comparator" AS ENUM('gt', 'gte', 'lt', 'lte');
CREATE TYPE "public"."alert_severity" AS ENUM('critical', 'warning', 'info');
CREATE TYPE "public"."alert_event_status" AS ENUM('active', 'resolved');

-- ─── alert_rules ─────────────────────────────────────────────────────
CREATE TABLE "alert_rules" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"        text NOT NULL,
  "metric"      "alert_metric" NOT NULL,
  "comparator"  "alert_comparator" DEFAULT 'gt' NOT NULL,
  "threshold"   double precision NOT NULL,
  "severity"    "alert_severity" DEFAULT 'warning' NOT NULL,
  "enabled"     boolean DEFAULT true NOT NULL,
  "channels"    text[] DEFAULT '{"inapp"}' NOT NULL,
  "created_by"  uuid,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "alert_rules" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_users_id_fk"
  FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null;

CREATE INDEX "idx_alert_rules_enabled" ON "alert_rules" USING btree ("enabled") WHERE "enabled";

CREATE POLICY "alert_rules_staff_all" ON "alert_rules" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL));

CREATE TRIGGER trg_alert_rules_updated_at
  BEFORE UPDATE ON "alert_rules" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── alert_events ────────────────────────────────────────────────────
CREATE TABLE "alert_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "rule_id"     uuid NOT NULL,
  "status"      "alert_event_status" DEFAULT 'active' NOT NULL,
  "severity"    "alert_severity" NOT NULL,
  "value"       double precision NOT NULL,
  "message"     text,
  "fired_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone
);

ALTER TABLE "alert_events" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_alert_rules_id_fk"
  FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade;

CREATE INDEX "idx_alert_events_rule" ON "alert_events" USING btree ("rule_id");
CREATE INDEX "idx_alert_events_fired" ON "alert_events" USING btree ("fired_at");
CREATE INDEX "idx_alert_events_active" ON "alert_events" USING btree ("rule_id") WHERE "status" = 'active';

CREATE POLICY "alert_events_staff_all" ON "alert_events" AS PERMISSIVE FOR ALL TO public
  USING (EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.staff_role IS NOT NULL));
