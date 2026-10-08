-- =====================================================================
-- Blink Server — Customer marketplace, promotions, coupons, favorites
-- =====================================================================
-- Authored to mirror src/db/schema/marketplace.ts, promotions.ts,
-- customer-favorites.ts and the new orders.store_id / coupon_id columns.
-- Additive only. Catalog tables are SELECT-able by any signed-in user;
-- customer-owned rows are own-only. All writes go through blink-server with
-- the service role. Seed data lives in 00033_marketplace_seed.sql.

CREATE TYPE "public"."store_status"     AS ENUM('active', 'inactive');
CREATE TYPE "public"."promotion_kind"   AS ENUM('promo', 'deal');
CREATE TYPE "public"."promotion_action" AS ENUM('activate', 'copy', 'claim', 'view');
CREATE TYPE "public"."discount_type"    AS ENUM('percent', 'fixed', 'free_delivery');
CREATE TYPE "public"."favorite_target"  AS ENUM('store', 'product');

-- ─── Catalog ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "marketplace_categories" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"        text NOT NULL UNIQUE,
  "label_key"   text NOT NULL,
  "icon"        text DEFAULT 'square.grid.2x2' NOT NULL,
  "bg_color"    text DEFAULT '#F2F2F7' NOT NULL,
  "icon_color"  text DEFAULT '#8E8E93' NOT NULL,
  "sort_order"  integer DEFAULT 0 NOT NULL,
  "is_active"   boolean DEFAULT true NOT NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "updated_at"  timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "stores" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"        uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "name"            text NOT NULL,
  "image"           text DEFAULT '' NOT NULL,
  "rating"          real DEFAULT 0 NOT NULL,
  "review_count"    integer DEFAULT 0 NOT NULL,
  "location"        text,
  "latitude"        double precision,
  "longitude"       double precision,
  "opening_hours"   text,
  "is_open"         boolean DEFAULT true NOT NULL,
  "delivery_fee"    numeric(10, 2) DEFAULT 0 NOT NULL,
  "delivery_time"   text,
  "min_order"       numeric(10, 2) DEFAULT 0 NOT NULL,
  "category_slugs"  text[] DEFAULT '{}'::text[] NOT NULL,
  "is_featured"     boolean DEFAULT false NOT NULL,
  "is_supermarket"  boolean DEFAULT false NOT NULL,
  "menu_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status"          "store_status" DEFAULT 'active' NOT NULL,
  "created_at"      timestamptz DEFAULT now() NOT NULL,
  "updated_at"      timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_stores_owner"  ON "stores" ("owner_id");
CREATE INDEX IF NOT EXISTS "idx_stores_status" ON "stores" ("status");
CREATE INDEX IF NOT EXISTS "idx_stores_category_slugs" ON "stores" USING gin ("category_slugs");

CREATE TABLE IF NOT EXISTS "store_products" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id"      uuid NOT NULL REFERENCES "public"."stores"("id") ON DELETE CASCADE,
  "title"         text NOT NULL,
  "description"   text,
  "price"         numeric(10, 2) DEFAULT 0 NOT NULL,
  "image"         text DEFAULT '' NOT NULL,
  "tag"           text,
  "menu_category" text,
  "rating"        real,
  "unit"          text,
  "is_available"  boolean DEFAULT true NOT NULL,
  "sort_order"    integer DEFAULT 0 NOT NULL,
  "created_at"    timestamptz DEFAULT now() NOT NULL,
  "updated_at"    timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_store_products_store" ON "store_products" ("store_id");

-- ─── Promotions & coupons ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "promotions" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind"           "promotion_kind" DEFAULT 'promo' NOT NULL,
  "category"       text DEFAULT 'MARKET' NOT NULL,
  "title"          text NOT NULL,
  "subtitle"       text DEFAULT '' NOT NULL,
  "image_url"      text DEFAULT '' NOT NULL,
  "code"           text,
  "action"         "promotion_action" DEFAULT 'activate' NOT NULL,
  "badge_text"     text,
  "badge_color"    text,
  "value_text"     text,
  "info_text"      text,
  "info_icon"      text,
  "store_id"       uuid REFERENCES "public"."stores"("id") ON DELETE SET NULL,
  "discount_type"  "discount_type" DEFAULT 'percent' NOT NULL,
  "discount_value" numeric(10, 2) DEFAULT 0 NOT NULL,
  "min_order"      numeric(10, 2) DEFAULT 0 NOT NULL,
  "max_discount"   numeric(10, 2),
  "valid_days"     integer DEFAULT 30 NOT NULL,
  "starts_at"      timestamptz,
  "ends_at"        timestamptz,
  "is_active"      boolean DEFAULT true NOT NULL,
  "sort_order"     integer DEFAULT 0 NOT NULL,
  "created_at"     timestamptz DEFAULT now() NOT NULL,
  "updated_at"     timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_promotions_kind" ON "promotions" ("kind");
CREATE INDEX IF NOT EXISTS "idx_promotions_code" ON "promotions" ("code");

CREATE TABLE IF NOT EXISTS "customer_coupons" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"        uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "promotion_id"   uuid REFERENCES "public"."promotions"("id") ON DELETE SET NULL,
  "code"           text NOT NULL,
  "type"           text DEFAULT 'others' NOT NULL,
  "title"          text NOT NULL,
  "description"    text DEFAULT '' NOT NULL,
  "discount_type"  "discount_type" NOT NULL,
  "discount_value" numeric(10, 2) DEFAULT 0 NOT NULL,
  "min_order"      numeric(10, 2) DEFAULT 0 NOT NULL,
  "max_discount"   numeric(10, 2),
  "image_url"      text,
  "expires_at"     timestamptz,
  "used_at"        timestamptz,
  "order_id"       uuid,
  "created_at"     timestamptz DEFAULT now() NOT NULL,
  "updated_at"     timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "customer_coupons_user_promotion_key" UNIQUE ("user_id", "promotion_id")
);
CREATE INDEX IF NOT EXISTS "idx_customer_coupons_user" ON "customer_coupons" ("user_id");

-- ─── Favorites ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "customer_favorites" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"     uuid NOT NULL REFERENCES "public"."users"("id") ON DELETE CASCADE,
  "target_type" "favorite_target" NOT NULL,
  "target_id"   uuid NOT NULL,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "customer_favorites_user_target_key" UNIQUE ("user_id", "target_type", "target_id")
);
CREATE INDEX IF NOT EXISTS "idx_customer_favorites_user" ON "customer_favorites" ("user_id");

-- ─── Orders ← store + coupon ─────────────────────────────────────────

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "store_id"  uuid REFERENCES "public"."stores"("id") ON DELETE SET NULL;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coupon_id" uuid REFERENCES "public"."customer_coupons"("id") ON DELETE SET NULL;
ALTER TABLE "customer_coupons"
  ADD CONSTRAINT "customer_coupons_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE SET NULL;

-- ─── RLS ─────────────────────────────────────────────────────────────

ALTER TABLE "marketplace_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stores"                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE "store_products"         ENABLE ROW LEVEL SECURITY;
ALTER TABLE "promotions"             ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_coupons"       ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_favorites"     ENABLE ROW LEVEL SECURITY;

CREATE POLICY "marketplace_categories_select_all" ON "marketplace_categories"
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "stores_select_active" ON "stores"
  FOR SELECT USING (status = 'active' OR auth.uid() = owner_id);
CREATE POLICY "store_products_select_all" ON "store_products"
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "promotions_select_all" ON "promotions"
  FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "customer_coupons_select_own" ON "customer_coupons"
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "customer_favorites_all_own" ON "customer_favorites"
  FOR ALL USING (auth.uid() = user_id);

-- ─── updated_at triggers ─────────────────────────────────────────────

CREATE TRIGGER trg_marketplace_categories_updated_at
  BEFORE UPDATE ON "marketplace_categories" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON "stores" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_store_products_updated_at
  BEFORE UPDATE ON "store_products" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_promotions_updated_at
  BEFORE UPDATE ON "promotions" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_customer_coupons_updated_at
  BEFORE UPDATE ON "customer_coupons" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
