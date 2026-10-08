-- =====================================================================
-- Blink Server — Merchant role: store management, catalog, packs, dues
-- =====================================================================
-- Authored to mirror src/db/schema/marketplace.ts (new stores/store_products
-- columns) and src/db/schema/merchant.ts (store_packs, merchant_dues_payments).
-- Additive only. All writes go through blink-server with the service role.

-- ─── Enums ───────────────────────────────────────────────────────────

-- Merchant-created stores wait for staff approval before customers see them.
ALTER TYPE "public"."store_status" ADD VALUE IF NOT EXISTS 'under_review';

CREATE TYPE "public"."product_review_status"   AS ENUM('approved', 'pending', 'rejected');
CREATE TYPE "public"."price_suggestion_status" AS ENUM('pending', 'accepted', 'rejected');
CREATE TYPE "public"."pack_status"             AS ENUM('active', 'under_review', 'inactive', 'archived');

-- ─── stores: merchant-managed fields ─────────────────────────────────

ALTER TABLE "stores"
  ADD COLUMN IF NOT EXISTS "description"     text,
  ADD COLUMN IF NOT EXISTS "phone"           text,
  ADD COLUMN IF NOT EXISTS "whatsapp"        text,
  ADD COLUMN IF NOT EXISTS "email"           text,
  ADD COLUMN IF NOT EXISTS "logo"            text,
  ADD COLUMN IF NOT EXISTS "gallery"         text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "city"            text,
  ADD COLUMN IF NOT EXISTS "wilaya"          text,
  ADD COLUMN IF NOT EXISTS "hours"           jsonb,
  ADD COLUMN IF NOT EXISTS "documents"       jsonb DEFAULT '{}'::jsonb NOT NULL,
  ADD COLUMN IF NOT EXISTS "manual_override" boolean DEFAULT false NOT NULL,
  ADD COLUMN IF NOT EXISTS "is_primary"      boolean DEFAULT false NOT NULL;

-- ─── store_products: merchant catalog + pricing ──────────────────────

ALTER TABLE "store_products"
  ADD COLUMN IF NOT EXISTS "barcode"            text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "brand"              text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "category"           text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS "stock"              integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "photos"             text[] DEFAULT '{}'::text[] NOT NULL,
  ADD COLUMN IF NOT EXISTS "library_product_id" uuid REFERENCES "public"."library_products"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "review_status"      "product_review_status" DEFAULT 'approved' NOT NULL,
  ADD COLUMN IF NOT EXISTS "blink_price"        numeric(10, 2) DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS "suggested_price"    numeric(10, 2),
  ADD COLUMN IF NOT EXISTS "suggestion_status"  "price_suggestion_status";

-- Seeded products: the reference price is the current price.
UPDATE "store_products" SET "blink_price" = "price" WHERE "blink_price" = 0;

-- ─── Packs (bundles) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "store_packs" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id"         uuid NOT NULL REFERENCES "public"."stores"("id") ON DELETE CASCADE,
  "name"             text NOT NULL,
  "description"      text,
  "image"            text,
  "items"            jsonb DEFAULT '[]'::jsonb NOT NULL,
  "discount_enabled" boolean DEFAULT false NOT NULL,
  "discount_percent" integer DEFAULT 0 NOT NULL,
  "free_delivery"    boolean DEFAULT false NOT NULL,
  "status"           "pack_status" DEFAULT 'active' NOT NULL,
  "created_at"       timestamptz DEFAULT now() NOT NULL,
  "updated_at"       timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_store_packs_store" ON "store_packs" ("store_id");

-- ─── Dues payments ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "merchant_dues_payments" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "merchant_id" uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "store_id"    uuid REFERENCES "public"."stores"("id") ON DELETE SET NULL,
  "amount"      numeric(10, 2) NOT NULL,
  "fees"        numeric(10, 2) DEFAULT 0 NOT NULL,
  "method"      text NOT NULL,
  "status"      "transaction_status" DEFAULT 'completed' NOT NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "updated_at"  timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_merchant_dues_merchant" ON "merchant_dues_payments" ("merchant_id");
CREATE INDEX IF NOT EXISTS "idx_merchant_dues_store"    ON "merchant_dues_payments" ("store_id");

-- ─── orders: store rating ────────────────────────────────────────────

ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "store_rating" smallint CHECK ("store_rating" BETWEEN 1 AND 5),
  ADD COLUMN IF NOT EXISTS "store_review" text,
  ADD COLUMN IF NOT EXISTS "merchant_status" text
    CHECK ("merchant_status" IN ('pending', 'accepted', 'ready', 'rejected'));
-- Existing store orders start pending so the merchant sees them.
UPDATE "orders" SET "merchant_status" = 'pending'
  WHERE "store_id" IS NOT NULL AND "merchant_status" IS NULL AND "status" = 'processing';
CREATE INDEX IF NOT EXISTS "idx_orders_store" ON "orders" ("store_id");

-- ─── RLS ─────────────────────────────────────────────────────────────

ALTER TABLE "store_packs"            ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_dues_payments" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "store_packs_select_all" ON "store_packs"
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "merchant_dues_select_own" ON "merchant_dues_payments"
  FOR SELECT USING (auth.uid() = merchant_id);

-- ─── updated_at triggers ─────────────────────────────────────────────

CREATE TRIGGER trg_store_packs_updated_at
  BEFORE UPDATE ON "store_packs" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_merchant_dues_payments_updated_at
  BEFORE UPDATE ON "merchant_dues_payments" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Storage: store photos, logos, product photos, verification docs ─

INSERT INTO storage.buckets (id, name, public)
VALUES ('merchant', 'merchant', true)
ON CONFLICT (id) DO NOTHING;
