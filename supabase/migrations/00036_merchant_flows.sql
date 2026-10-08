-- =====================================================================
-- Blink Server — Merchant flows: order handling, store drivers, strategy
-- =====================================================================
-- Mirrors src/db/schema/orders.ts, rider-profiles.ts, marketplace.ts (stores
-- weekly_goal) and merchant.ts (store_drivers, merchant_suggestions,
-- merchant_ai_messages). Additive only; writes go through blink-server.

-- ─── Notifications: merchant "Efficiency" tab ────────────────────────
ALTER TYPE "public"."notification_type" ADD VALUE IF NOT EXISTS 'improvement';

-- ─── Store drivers (merchant's own riders) ───────────────────────────
-- kind=blink: a Blink rider invited by phone (rider_user_id, status invited →
-- active once the rider accepts); kind=external: a driver the merchant manages
-- off-platform (name/phone/vehicle, active at once).
CREATE TABLE IF NOT EXISTS "store_drivers" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id"      uuid NOT NULL REFERENCES "public"."stores"("id") ON DELETE CASCADE,
  "kind"          text NOT NULL CHECK ("kind" IN ('blink', 'external')),
  "rider_user_id" uuid REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "full_name"     text NOT NULL,
  "phone"         text,
  "vehicle_type"  text,
  "plate_number"  text,
  "notes"         text,
  "status"        text DEFAULT 'active' NOT NULL
    CHECK ("status" IN ('invited', 'active', 'inactive', 'declined')),
  "created_at"    timestamptz DEFAULT now() NOT NULL,
  "updated_at"    timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "store_drivers_store_rider_key" UNIQUE ("store_id", "rider_user_id")
);
CREATE INDEX IF NOT EXISTS "idx_store_drivers_store" ON "store_drivers" ("store_id");
CREATE INDEX IF NOT EXISTS "idx_store_drivers_rider" ON "store_drivers" ("rider_user_id");

-- ─── orders: merchant handling + delivery timeline ───────────────────
ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "merchant_reject_reason" text
    CHECK ("merchant_reject_reason" IN ('too_busy', 'out_of_stock', 'closing_soon', 'cannot_fulfil')),
  ADD COLUMN IF NOT EXISTS "delivery_mode" text CHECK ("delivery_mode" IN ('blink', 'own')),
  ADD COLUMN IF NOT EXISTS "store_driver_id" uuid REFERENCES "public"."store_drivers"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "canceled_by" text CHECK ("canceled_by" IN ('customer', 'merchant', 'system')),
  ADD COLUMN IF NOT EXISTS "accepted_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "prepared_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "rider_assigned_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "picked_up_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "delivered_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "canceled_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "store_review_reply" text,
  ADD COLUMN IF NOT EXISTS "store_review_replied_at" timestamptz;

-- ─── rider_profiles: availability + last known position ──────────────
ALTER TABLE "rider_profiles"
  ADD COLUMN IF NOT EXISTS "is_available" boolean DEFAULT true NOT NULL,
  ADD COLUMN IF NOT EXISTS "latitude" double precision,
  ADD COLUMN IF NOT EXISTS "longitude" double precision,
  ADD COLUMN IF NOT EXISTS "location_updated_at" timestamptz;

-- ─── stores: weekly revenue goal ─────────────────────────────────────
ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "weekly_goal" numeric(10, 2) DEFAULT 0 NOT NULL;

-- ─── Strategy: saved suggestions + Blink AI chat ─────────────────────
CREATE TABLE IF NOT EXISTS "merchant_suggestions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "store_id"    uuid REFERENCES "public"."stores"("id") ON DELETE CASCADE,
  "source"      text DEFAULT 'chat' NOT NULL CHECK ("source" IN ('chat', 'system')),
  "kind"        text DEFAULT 'general' NOT NULL,
  "title"       text NOT NULL,
  "body"        text NOT NULL,
  "data"        jsonb DEFAULT '{}'::jsonb NOT NULL,
  "status"      text DEFAULT 'new' NOT NULL CHECK ("status" IN ('new', 'applied', 'dismissed')),
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "updated_at"  timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_merchant_suggestions_merchant" ON "merchant_suggestions" ("merchant_id");

CREATE TABLE IF NOT EXISTS "merchant_ai_messages" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "store_id"    uuid REFERENCES "public"."stores"("id") ON DELETE CASCADE,
  "role"        text NOT NULL CHECK ("role" IN ('user', 'assistant')),
  "content"     text NOT NULL,
  "suggestion_id" uuid REFERENCES "public"."merchant_suggestions"("id") ON DELETE SET NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "updated_at"  timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_merchant_ai_messages_merchant" ON "merchant_ai_messages" ("merchant_id", "created_at");

-- ─── RLS ─────────────────────────────────────────────────────────────
ALTER TABLE "store_drivers"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_suggestions"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_ai_messages"  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_drivers_select_rider" ON "store_drivers"
  FOR SELECT USING (auth.uid() = rider_user_id);
CREATE POLICY "merchant_suggestions_select_own" ON "merchant_suggestions"
  FOR SELECT USING (auth.uid() = merchant_id);
CREATE POLICY "merchant_ai_messages_select_own" ON "merchant_ai_messages"
  FOR SELECT USING (auth.uid() = merchant_id);

-- ─── updated_at triggers ─────────────────────────────────────────────
CREATE TRIGGER trg_store_drivers_updated_at
  BEFORE UPDATE ON "store_drivers" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_merchant_suggestions_updated_at
  BEFORE UPDATE ON "merchant_suggestions" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_merchant_ai_messages_updated_at
  BEFORE UPDATE ON "merchant_ai_messages" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
