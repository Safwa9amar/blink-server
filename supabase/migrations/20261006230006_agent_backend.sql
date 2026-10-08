-- =====================================================================
-- Blink Server — Agent role backend: multi-shop, Blink Cash dues, perks
-- =====================================================================
-- Mirrors src/db/schema/agent-shops.ts, transactions.ts (shop_id) and
-- agent.ts. Additive except for swapping agent_shops' one-shop-per-agent
-- UNIQUE(user_id) for "one PRIMARY shop per agent".

-- ─── agent_shops: several shops per agent ────────────────────────────

ALTER TABLE "agent_shops"
  ADD COLUMN IF NOT EXISTS "email"           text,
  ADD COLUMN IF NOT EXISTS "description"     text,
  ADD COLUMN IF NOT EXISTS "is_primary"      boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "hours"           jsonb,
  ADD COLUMN IF NOT EXISTS "documents"       jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "manual_override" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "review_status"   text DEFAULT 'under_review' NOT NULL
    CHECK ("review_status" IN ('under_review', 'active', 'rejected'));

-- Every existing row was its agent's only shop: make it the primary, and treat
-- it as already verified (it predates review).
UPDATE "agent_shops" SET "is_primary" = true, "review_status" = 'active'
  WHERE NOT EXISTS (
    SELECT 1 FROM "agent_shops" s2
    WHERE s2.user_id = agent_shops.user_id AND s2.is_primary
  );

ALTER TABLE "agent_shops" DROP CONSTRAINT IF EXISTS "agent_shops_user_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "agent_shops_one_primary"
  ON "agent_shops" ("user_id") WHERE "is_primary";

-- ─── agent_profiles: business documents ──────────────────────────────
-- { commercial_register_front|back: { url, status pending|verified|rejected,
--   reason }, nif, nis } — reviewed by staff.

ALTER TABLE "agent_profiles"
  ADD COLUMN IF NOT EXISTS "documents" jsonb DEFAULT '{}'::jsonb NOT NULL;

-- ─── transactions: which shop an operation went through ──────────────

ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "shop_id" uuid REFERENCES "public"."agent_shops"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_transactions_shop" ON "transactions" ("shop_id");

-- The agent's rating of the rider, left on the receipt after an operation.
ALTER TABLE "transactions"
  ADD COLUMN IF NOT EXISTS "rider_rating" smallint
    CONSTRAINT "transactions_rider_rating_check" CHECK ("rider_rating" >= 1 AND "rider_rating" <= 5),
  ADD COLUMN IF NOT EXISTS "rider_feedback" text;

-- Operations processed before shops were tracked count toward the primary shop.
UPDATE "transactions" t SET "shop_id" = s.id
  FROM "agent_shops" s
  WHERE t.shop_id IS NULL AND t.agent_id IS NOT NULL
    AND s.user_id = t.agent_id AND s.is_primary;

-- ─── Dues payments ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agent_dues_payments" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id"   uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "amount"     numeric(10, 2) NOT NULL CHECK ("amount" > 0),
  "fees"       numeric(10, 2) DEFAULT 0 NOT NULL,
  "method"     text NOT NULL,
  "status"     "transaction_status" DEFAULT 'completed' NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_agent_dues_agent" ON "agent_dues_payments" ("agent_id");
ALTER TABLE "agent_dues_payments" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_dues_select_own" ON "agent_dues_payments";
CREATE POLICY "agent_dues_select_own" ON "agent_dues_payments"
  FOR SELECT USING (auth.uid() = agent_id);
DROP TRIGGER IF EXISTS trg_agent_dues_payments_updated_at ON "agent_dues_payments";
CREATE TRIGGER trg_agent_dues_payments_updated_at
  BEFORE UPDATE ON "agent_dues_payments" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Perks: partner benefits ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agent_benefits" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_name" text NOT NULL,
  "offer_text"   text NOT NULL,
  "offer_title"  text,
  "subtext"      text,
  "category"     text DEFAULT 'other' NOT NULL CHECK ("category" IN ('supplies', 'telecom', 'other')),
  "image_url"    text,
  "about_text"   text,
  "redeem_steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "terms"        jsonb DEFAULT '[]'::jsonb NOT NULL,
  "phone"        text,
  "location"     text,
  "valid_until"  timestamptz,
  "is_active"    boolean DEFAULT true NOT NULL,
  "sort_order"   integer DEFAULT 0 NOT NULL,
  "created_at"   timestamptz DEFAULT now() NOT NULL,
  "updated_at"   timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE "agent_benefits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_benefits_select_active" ON "agent_benefits";
CREATE POLICY "agent_benefits_select_active" ON "agent_benefits" FOR SELECT USING (is_active);
DROP TRIGGER IF EXISTS trg_agent_benefits_updated_at ON "agent_benefits";
CREATE TRIGGER trg_agent_benefits_updated_at
  BEFORE UPDATE ON "agent_benefits" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Perks: operation challenges ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "agent_challenges" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title"             text NOT NULL,
  "image_url"         text,
  "rules"             text NOT NULL,
  "reward_amount"     numeric(10, 2) NOT NULL CHECK ("reward_amount" >= 0),
  "target_operations" integer NOT NULL CHECK ("target_operations" > 0),
  "operation_type"    text CHECK ("operation_type" IN ('deposit', 'withdrawal')),
  "hour_from"         smallint CHECK ("hour_from" BETWEEN 0 AND 23),
  "hour_to"           smallint CHECK ("hour_to" BETWEEN 1 AND 24),
  "max_cancellations" integer CHECK ("max_cancellations" >= 0),
  "starts_at"         timestamptz NOT NULL,
  "ends_at"           timestamptz NOT NULL,
  "is_active"         boolean DEFAULT true NOT NULL,
  "created_at"        timestamptz DEFAULT now() NOT NULL,
  "updated_at"        timestamptz DEFAULT now() NOT NULL,
  CHECK ("ends_at" > "starts_at")
);
CREATE INDEX IF NOT EXISTS "idx_agent_challenges_ends" ON "agent_challenges" ("ends_at");
ALTER TABLE "agent_challenges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_challenges_select_active" ON "agent_challenges";
CREATE POLICY "agent_challenges_select_active" ON "agent_challenges" FOR SELECT USING (is_active);
DROP TRIGGER IF EXISTS trg_agent_challenges_updated_at ON "agent_challenges";
CREATE TRIGGER trg_agent_challenges_updated_at
  BEFORE UPDATE ON "agent_challenges" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS "agent_challenge_participants" (
  "challenge_id"  uuid NOT NULL REFERENCES "public"."agent_challenges"("id") ON DELETE CASCADE,
  "agent_id"      uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "status"        text DEFAULT 'joined' NOT NULL CHECK ("status" IN ('joined', 'won', 'lost', 'gave_up')),
  "joined_at"     timestamptz DEFAULT now() NOT NULL,
  "settled_at"    timestamptz,
  "reward_amount" numeric(10, 2),
  PRIMARY KEY ("challenge_id", "agent_id")
);
CREATE INDEX IF NOT EXISTS "idx_agent_challenge_participants_agent" ON "agent_challenge_participants" ("agent_id");
-- Server-only (service role); no client policies.
ALTER TABLE "agent_challenge_participants" ENABLE ROW LEVEL SECURITY;

-- ─── Seed: starter perks content ─────────────────────────────────────

INSERT INTO "agent_benefits"
  ("partner_name", "offer_text", "offer_title", "subtext", "category", "image_url", "about_text", "redeem_steps", "terms", "phone", "location", "valid_until", "sort_order")
SELECT * FROM (VALUES
  ('Ooredoo', 'Free Daily Data', '1GB Free Daily Data with Ooredoo', '1GB extra for active agents', 'telecom',
   'https://images.unsplash.com/photo-1536412597336-ade7b523ec3f?q=80&w=1200&auto=format&fit=crop',
   'Stay connected while you serve riders: active Blink agents get 1GB of extra data every day on their Ooredoo line.',
   '["Visit an Ooredoo store with your ID.", "Show your Blink Agent profile in the app.", "The bonus is activated on your line."]'::jsonb,
   '["Ooredoo prepaid and postpaid lines only.", "Requires at least one processed operation per week."]'::jsonb,
   NULL, NULL, now() + interval '6 months', 1),
  ('Bureau Plus', '15% Off Office Supplies', '15% Off Office Supplies at Bureau Plus', 'Receipt paper, ink and stationery', 'supplies',
   'https://images.unsplash.com/photo-1586075010923-2dd4570fb338?q=80&w=1200&auto=format&fit=crop',
   'Keep your counter stocked: Blink agents get 15% off receipt rolls, printer ink and stationery at every Bureau Plus branch.',
   '["Visit any Bureau Plus branch.", "Show your Blink Agent profile in the app.", "The discount is applied at checkout."]'::jsonb,
   '["Not combinable with other promotions.", "Maximum one purchase per week."]'::jsonb,
   '+213 550 222 333', 'Algiers, Algeria', now() + interval '6 months', 2),
  ('SafeBox DZ', '20% Off Cash Safes', '20% Off Cash Safes & Counting Machines', 'Secure the cash you hold for Blink', 'supplies',
   'https://images.unsplash.com/photo-1563013544-824ae1b704d3?q=80&w=1200&auto=format&fit=crop',
   'Protect your float: 20% off certified cash safes and banknote counting machines for verified Blink agents.',
   '["Contact SafeBox DZ by phone or visit the showroom.", "Show your verified Blink Agent profile.", "Get 20% off your order."]'::jsonb,
   '["Verified agents only.", "Delivery and installation are charged separately."]'::jsonb,
   '+213 550 444 555', 'Oran, Algeria', now() + interval '6 months', 3),
  ('Djezzy', 'Business Line Discount', '30% Off a Djezzy Business Line', 'For your shop phone', 'telecom',
   'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?q=80&w=1200&auto=format&fit=crop',
   'Give riders a reliable number to reach your shop: 30% off any Djezzy business plan for 12 months.',
   '["Visit a Djezzy store.", "Show your Blink Agent profile.", "Sign up for a business plan to get the discount."]'::jsonb,
   '["New business lines only.", "Discount applies for the first 12 months."]'::jsonb,
   NULL, NULL, now() + interval '6 months', 4)
) AS v
WHERE NOT EXISTS (SELECT 1 FROM "agent_benefits");

INSERT INTO "agent_challenges"
  ("title", "image_url", "rules", "reward_amount", "target_operations", "operation_type", "hour_from", "hour_to", "max_cancellations", "starts_at", "ends_at")
SELECT * FROM (VALUES
  ('Deposit Champion', 'https://images.unsplash.com/photo-1554224155-6726b3ff858f?q=80&w=1200',
   'Process 20 rider deposits before the challenge ends to earn a 2,000 DZD bonus, credited against your dues. Cancelled operations do not count.',
   2000::numeric, 20, 'deposit', NULL::smallint, NULL::smallint, NULL::integer, now(), now() + interval '7 days'),
  ('Cash-Out Hero', 'https://images.unsplash.com/photo-1601597111158-2fceff292cdc?q=80&w=1200',
   'Process 15 rider withdrawals before the challenge ends to earn 1,200 DZD. No more than 3 cancelled operations.',
   1200::numeric, 15, 'withdrawal', NULL::smallint, NULL::smallint, 3, now(), now() + interval '14 days'),
  ('Early Opener', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?q=80&w=1200',
   'Process 10 operations before 10:00 AM to earn an extra 800 DZD.',
   800::numeric, 10, NULL, 0::smallint, 10::smallint, NULL, now(), now() + interval '7 days'),
  ('Monthly Volume', 'https://images.unsplash.com/photo-1579621970563-ebec7560ff3e?q=80&w=1200',
   'Process 60 deposits or withdrawals within 30 days to earn a 3,000 DZD bonus.',
   3000::numeric, 60, NULL, NULL, NULL, NULL, now(), now() + interval '30 days')
) AS v
WHERE NOT EXISTS (SELECT 1 FROM "agent_challenges");

-- ─── Storage: shop photos + verification documents ───────────────────

INSERT INTO storage.buckets (id, name, public)
VALUES ('agent', 'agent', true)
ON CONFLICT (id) DO NOTHING;
