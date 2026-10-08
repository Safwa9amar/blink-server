-- =====================================================================
-- Blink Server — Rider dispatch: job offers, accept/advance, trip records
-- =====================================================================
-- Mirrors src/db/schema/trips.ts and rider-order-declines.ts. Additive only;
-- writes go through blink-server (/riders/jobs/*).

-- ─── trips: link to the delivered order + rider's rating of the customer ──
ALTER TABLE "trips"
  ADD COLUMN IF NOT EXISTS "order_id" uuid REFERENCES "public"."orders"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "customer_rating" smallint
    CHECK ("customer_rating" BETWEEN 1 AND 5);
CREATE UNIQUE INDEX IF NOT EXISTS "trips_order_id_key" ON "trips" ("order_id");

-- ─── Orders a rider declined (never re-offered to them) ──────────────
CREATE TABLE IF NOT EXISTS "rider_order_declines" (
  "order_id"   uuid NOT NULL REFERENCES "public"."orders"("id") ON DELETE CASCADE,
  "rider_id"   uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "stage"      text DEFAULT 'offer' NOT NULL CHECK ("stage" IN ('offer', 'post_accept')),
  "reason"     text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  PRIMARY KEY ("order_id", "rider_id")
);
CREATE INDEX IF NOT EXISTS "idx_rider_order_declines_rider" ON "rider_order_declines" ("rider_id");

-- Server-only table (service role); no client policies.
ALTER TABLE "rider_order_declines" ENABLE ROW LEVEL SECURITY;
