-- =====================================================================
-- Blink Server — Blink Library: trilingual text + multi-photo products
-- =====================================================================
-- DRAFT — review before applying (npm run db:push / db:reset).
--
-- Authored in Drizzle (src/db/schema/library-categories.ts + library-products.ts);
-- kept here so the existing Supabase pipeline applies it. Additive + transform,
-- idempotent where practical. Mirrors the 00004_news_content_langs.sql pattern
-- (add per-language columns, carry the old value into *_en, drop the old column).
--
-- Two changes the dashboard /d/library now expects:
--   1. name/description become one TEXT column per language (en/fr/ar). Products
--      keep referencing their category by the ENGLISH name (category = name_en).
--   2. products.photo_url (single) becomes products.photos (text[], up to 5; [0] = cover).

-- ── library_categories: name → name_en / name_fr / name_ar ───────────────────
ALTER TABLE "library_categories"
  ADD COLUMN IF NOT EXISTS "name_en" text,
  ADD COLUMN IF NOT EXISTS "name_fr" text,
  ADD COLUMN IF NOT EXISTS "name_ar" text;

-- Carry the existing single name into English; leave fr/ar blank for the admin to fill.
UPDATE "library_categories" SET
  name_en = COALESCE(name_en, name, ''),
  name_fr = COALESCE(name_fr, ''),
  name_ar = COALESCE(name_ar, '');

ALTER TABLE "library_categories"
  ALTER COLUMN "name_en" SET DEFAULT '',
  ALTER COLUMN "name_fr" SET DEFAULT '',
  ALTER COLUMN "name_ar" SET DEFAULT '',
  ALTER COLUMN "name_en" SET NOT NULL,
  ALTER COLUMN "name_fr" SET NOT NULL,
  ALTER COLUMN "name_ar" SET NOT NULL;

-- Move the uniqueness from the old `name` onto the canonical `name_en`.
ALTER TABLE "library_categories" DROP CONSTRAINT IF EXISTS "library_categories_name_unique";
ALTER TABLE "library_categories" ADD CONSTRAINT "library_categories_name_en_unique" UNIQUE ("name_en");

ALTER TABLE "library_categories" DROP COLUMN IF EXISTS "name";

-- ── library_products: name/description → *_en/_fr/_ar, photo_url → photos[] ───
ALTER TABLE "library_products"
  ADD COLUMN IF NOT EXISTS "name_en" text,
  ADD COLUMN IF NOT EXISTS "name_fr" text,
  ADD COLUMN IF NOT EXISTS "name_ar" text,
  ADD COLUMN IF NOT EXISTS "description_en" text,
  ADD COLUMN IF NOT EXISTS "description_fr" text,
  ADD COLUMN IF NOT EXISTS "description_ar" text,
  ADD COLUMN IF NOT EXISTS "photos" text[];

UPDATE "library_products" SET
  name_en        = COALESCE(name_en, name, ''),
  name_fr        = COALESCE(name_fr, ''),
  name_ar        = COALESCE(name_ar, ''),
  description_en = COALESCE(description_en, description, ''),
  description_fr = COALESCE(description_fr, ''),
  description_ar = COALESCE(description_ar, ''),
  photos         = COALESCE(
                     photos,
                     CASE WHEN photo_url IS NOT NULL AND photo_url <> ''
                          THEN ARRAY[photo_url] ELSE ARRAY[]::text[] END
                   );

ALTER TABLE "library_products"
  ALTER COLUMN "name_en" SET DEFAULT '',
  ALTER COLUMN "name_fr" SET DEFAULT '',
  ALTER COLUMN "name_ar" SET DEFAULT '',
  ALTER COLUMN "description_en" SET DEFAULT '',
  ALTER COLUMN "description_fr" SET DEFAULT '',
  ALTER COLUMN "description_ar" SET DEFAULT '',
  ALTER COLUMN "photos" SET DEFAULT '{}',
  ALTER COLUMN "name_en" SET NOT NULL,
  ALTER COLUMN "name_fr" SET NOT NULL,
  ALTER COLUMN "name_ar" SET NOT NULL,
  ALTER COLUMN "description_en" SET NOT NULL,
  ALTER COLUMN "description_fr" SET NOT NULL,
  ALTER COLUMN "description_ar" SET NOT NULL,
  ALTER COLUMN "photos" SET NOT NULL;

ALTER TABLE "library_products"
  DROP COLUMN IF EXISTS "name",
  DROP COLUMN IF EXISTS "description",
  DROP COLUMN IF EXISTS "photo_url";

-- RLS policies, indexes and updated_at triggers from 00006_library.sql are
-- column-agnostic (status / category), so they keep working untouched.
