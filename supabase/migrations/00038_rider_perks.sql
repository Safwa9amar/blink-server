-- =====================================================================
-- Blink Server — Rider perks: partner benefits + trip challenges
-- =====================================================================
-- Mirrors src/db/schema/rider-perks.ts. Additive only; riders read through
-- blink-server (/riders/benefits, /riders/challenges), staff manage content.

CREATE TABLE IF NOT EXISTS "rider_benefits" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "partner_name" text NOT NULL,
  "offer_text"   text NOT NULL,
  "offer_title"  text,
  "subtext"      text,
  "category"     text DEFAULT 'other' NOT NULL CHECK ("category" IN ('fuel', 'maintenance', 'other')),
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
ALTER TABLE "rider_benefits" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rider_benefits_select_active" ON "rider_benefits";
CREATE POLICY "rider_benefits_select_active" ON "rider_benefits" FOR SELECT USING (is_active);

CREATE TABLE IF NOT EXISTS "rider_challenges" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "title"             text NOT NULL,
  "image_url"         text,
  "rules"             text NOT NULL,
  "reward_amount"     numeric(10, 2) NOT NULL CHECK ("reward_amount" >= 0),
  "target_trips"      integer NOT NULL CHECK ("target_trips" > 0),
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
CREATE INDEX IF NOT EXISTS "idx_rider_challenges_ends" ON "rider_challenges" ("ends_at");
ALTER TABLE "rider_challenges" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rider_challenges_select_active" ON "rider_challenges";
CREATE POLICY "rider_challenges_select_active" ON "rider_challenges" FOR SELECT USING (is_active);

CREATE TABLE IF NOT EXISTS "rider_challenge_participants" (
  "challenge_id"  uuid NOT NULL REFERENCES "public"."rider_challenges"("id") ON DELETE CASCADE,
  "rider_id"      uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "status"        text DEFAULT 'joined' NOT NULL CHECK ("status" IN ('joined', 'won', 'lost', 'gave_up')),
  "joined_at"     timestamptz DEFAULT now() NOT NULL,
  "settled_at"    timestamptz,
  "reward_amount" numeric(10, 2),
  PRIMARY KEY ("challenge_id", "rider_id")
);
CREATE INDEX IF NOT EXISTS "idx_rider_challenge_participants_rider" ON "rider_challenge_participants" ("rider_id");
-- Server-only (service role); no client policies.
ALTER TABLE "rider_challenge_participants" ENABLE ROW LEVEL SECURITY;

-- ─── Seed: the content the app shipped with as static mocks ──────────
INSERT INTO "rider_benefits"
  ("partner_name", "offer_text", "offer_title", "subtext", "category", "image_url", "about_text", "redeem_steps", "terms", "phone", "location", "valid_until", "sort_order")
SELECT * FROM (VALUES
  ('TotalEnergies', '15% Off Oil Changes', '15% Off Oil Changes at TotalEnergies', 'Valid at all partner stations in DZD', 'fuel',
   'https://images.unsplash.com/photo-1542361345-89e58247f2d5?q=80&w=1200&auto=format&fit=crop',
   'Exclusive discounts on premium engine oils for Blink riders at every partner TotalEnergies station.',
   '["Go to any partner TotalEnergies station.", "Show your Blink Rider profile in the app.", "The discount is applied at checkout."]'::jsonb,
   '["Maximum once per month.", "Engine oil change only."]'::jsonb,
   NULL, 'Algiers, Algeria', now() + interval '6 months', 1),
  ('AutoPro Algiers', 'Tire Repair Discount', '15% Off Spare Parts at AutoPro', 'Flat 500 DZD off for Blink riders', 'maintenance',
   'https://images.unsplash.com/photo-1503664142530-00ec8a9a9786?q=80&w=1200&auto=format&fit=crop',
   'Blink Riders get an exclusive 15% discount on all mechanical spare parts at any AutoPro branch across Algiers and Oran. Keep your vehicle in top condition for less.',
   '["Visit any AutoPro branch during business hours.", "Present your Blink Rider ID profile from the app.", "The discount will be applied directly to your invoice."]'::jsonb,
   '["Discount applies to spare parts only, labor costs are excluded.", "Cannot be combined with other ongoing promotions.", "Valid for active Blink Riders with a rating above 4.5.", "Subject to availability of stock at the branch."]'::jsonb,
   '+213 550 123 456', 'Algiers, Algeria', now() + interval '6 months', 2),
  ('Pharmacie Centrale', '10% Health Items', '10% Off Health Items at Pharmacie Centrale', 'On all essential medical kits', 'other',
   'https://images.unsplash.com/photo-1586015555751-63bb77f4322a?q=80&w=1200&auto=format&fit=crop',
   'Stay safe on the road: 10% off first-aid and essential medical kits.',
   '["Visit Pharmacie Centrale.", "Show your Blink Rider profile.", "Get 10% off at the till."]'::jsonb,
   '["Prescription medicines excluded."]'::jsonb,
   NULL, 'Algiers, Algeria', now() + interval '6 months', 3),
  ('Ooredoo', 'Free Daily Data', '1GB Free Daily Data with Ooredoo', '1GB extra for active riders', 'other',
   'https://images.unsplash.com/photo-1536412597336-ade7b523ec3f?q=80&w=1200&auto=format&fit=crop',
   'Active Blink riders get 1GB of extra data every day on their Ooredoo line.',
   '["Visit an Ooredoo store with your ID.", "Show your Blink Rider profile.", "The bonus is activated on your line."]'::jsonb,
   '["Ooredoo prepaid and postpaid lines only.", "Requires at least one completed trip per week."]'::jsonb,
   NULL, NULL, now() + interval '6 months', 4),
  ('FoodHouse', 'Combo Meal Deal', 'Rider Combo Meal at FoodHouse', 'Only 450 DZD for riders', 'other',
   'https://images.unsplash.com/photo-1550547660-d9450f859349?q=80&w=1200&auto=format&fit=crop',
   'A full combo meal for 450 DZD — exclusive to Blink riders.',
   '["Order the Rider Combo at any FoodHouse.", "Show your Blink Rider profile."]'::jsonb,
   '["One combo per visit."]'::jsonb,
   NULL, 'Algiers, Algeria', now() + interval '6 months', 5),
  ('Blink Wash', 'Free Weekly Wash', 'Free Weekly Wash at Blink Wash', 'Complete exterior detailing', 'maintenance',
   'https://images.unsplash.com/photo-1601362840469-51e4d8d59085?q=80&w=1200&auto=format&fit=crop',
   'Keep your vehicle shining: one free exterior wash every week.',
   '["Visit a Blink Wash point.", "Show your Blink Rider profile."]'::jsonb,
   '["One wash per week.", "Exterior only."]'::jsonb,
   NULL, 'Algiers, Algeria', now() + interval '6 months', 6)
) AS v
WHERE NOT EXISTS (SELECT 1 FROM "rider_benefits");

INSERT INTO "rider_challenges"
  ("title", "image_url", "rules", "reward_amount", "target_trips", "hour_from", "hour_to", "max_cancellations", "starts_at", "ends_at")
SELECT * FROM (VALUES
  ('Weekend Warrior', 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?q=80&w=1200',
   'Complete 25 trips before the challenge ends to earn an extra 2,500 DZD. Cancelled orders do not count.',
   2500::numeric, 25, NULL::smallint, NULL::smallint, NULL::integer, now(), now() + interval '14 days'),
  ('Night Owl', 'https://images.unsplash.com/photo-1477959858617-67f85cf4f1df?q=80&w=1200',
   'Complete 15 trips between 20:00 and midnight to earn an extra 1,200 DZD. No more than 10 cancellations.',
   1200::numeric, 15, 20::smallint, 24::smallint, 10, now(), now() + interval '14 days'),
  ('Morning Rush', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?q=80&w=1200',
   'Complete 10 trips before 10:00 AM to earn an extra 800 DZD.',
   800::numeric, 10, 0::smallint, 10::smallint, NULL, now(), now() + interval '7 days'),
  ('Speed Surge', 'https://images.unsplash.com/photo-1568605117036-5fe5e7bab0b7?q=80&w=1200',
   'Complete 30 trips within the week to earn a bonus of 3,000 DZD.',
   3000::numeric, 30, NULL, NULL, NULL, now(), now() + interval '30 days')
) AS v
WHERE NOT EXISTS (SELECT 1 FROM "rider_challenges");
