-- =====================================================================
-- Blink Server — Blink Library (master product catalog)
-- =====================================================================
-- Authored in Drizzle (src/db/schema/library-categories.ts + library-products.ts).
-- Kept here as a Supabase migration so the existing `npm run db:push` / `db:reset`
-- pipeline applies it. Additive only — no changes to the baseline tables in 00001.
--
-- The dashboard admin console (blink-dashboard /d/library) curates this catalog via
-- the service role; the mobile app's merchant "Blink Library" picker reads it
-- (anon key, RLS-scoped to active categories / published products).

CREATE TYPE "public"."library_category_status" AS ENUM('active', 'inactive');
CREATE TYPE "public"."library_product_status" AS ENUM('published', 'draft', 'archived');

CREATE TABLE "library_categories" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"        text NOT NULL,
  "slug"        text NOT NULL,
  "icon"        text DEFAULT 'grid' NOT NULL,
  "status"      "library_category_status" DEFAULT 'active' NOT NULL,
  "sort_order"  integer DEFAULT 0 NOT NULL,
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "library_categories_name_unique" UNIQUE("name"),
  CONSTRAINT "library_categories_slug_unique" UNIQUE("slug")
);

CREATE TABLE "library_products" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name"         text NOT NULL,
  "description"  text DEFAULT '' NOT NULL,
  "barcode"      text DEFAULT '' NOT NULL,
  "brand"        text DEFAULT '' NOT NULL,
  "category"     text DEFAULT '' NOT NULL,
  "unit"         text DEFAULT '' NOT NULL,
  "photo_url"    text DEFAULT '' NOT NULL,
  "status"       "library_product_status" DEFAULT 'draft' NOT NULL,
  "store_count"  integer DEFAULT 0 NOT NULL,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"   timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "library_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "library_products" ENABLE ROW LEVEL SECURITY;

CREATE INDEX "idx_library_categories_status" ON "library_categories" USING btree ("status");
CREATE INDEX "idx_library_products_status" ON "library_products" USING btree ("status");
CREATE INDEX "idx_library_products_category" ON "library_products" USING btree ("category");

-- App reads active categories & published products; admin writes go through the service role.
CREATE POLICY "library_categories_select_active" ON "library_categories" AS PERMISSIVE FOR SELECT TO public USING (status = 'active');
CREATE POLICY "library_products_select_published" ON "library_products" AS PERMISSIVE FOR SELECT TO public USING (status = 'published');

-- updated_at auto-bump (reuses update_updated_at() from 00001).
CREATE TRIGGER trg_library_categories_updated_at
  BEFORE UPDATE ON "library_categories" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_library_products_updated_at
  BEFORE UPDATE ON "library_products" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Seed: 6 categories (mirrors the dashboard SEED_CATEGORIES) ──────────────
INSERT INTO "library_categories" ("name", "slug", "icon", "status", "sort_order") VALUES
  ('Food',      'food',      'fire',     'active', 1),
  ('Drinks',    'drinks',    'tag',      'active', 2),
  ('Dairy',     'dairy',     'package',  'active', 3),
  ('Snacks',    'snacks',    'gift',     'active', 4),
  ('Fresh',     'fresh',     'trending', 'active', 5),
  ('Household', 'household', 'grid',     'active', 6)
ON CONFLICT (slug) DO NOTHING;

-- ── Seed: ≈18 Algerian catalog items (only when the table is empty) ─────────
INSERT INTO "library_products" ("name","description","barcode","brand","category","unit","photo_url","status","store_count")
SELECT s.name, s.description, s.barcode, s.brand, s.category, s.unit, s.photo_url, s.status::library_product_status, s.store_count
FROM (VALUES
  ('Coca-Cola 1L','Carbonated soft drink','6130001000017','Coca-Cola Company','Drinks','1L Bottle','https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80','published',142),
  ('Pepsi 1L','Carbonated soft drink','6130001000024','PepsiCo','Drinks','1L Bottle','https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80','published',121),
  ('Hamoud Boualem 1L','Traditional Algerian soda','6130001000031','Hamoud Boualem','Drinks','1L Bottle','https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80','published',167),
  ('Jus Rouiba 1L','Orange nectar juice','6130001000048','Rouiba SPA','Drinks','1L Carton','https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80','published',98),
  ('Ifri Eau Minérale 1.5L','Natural mineral water','6130001000055','Ifri','Drinks','1.5L Bottle','https://images.unsplash.com/photo-1629203851122-3726ecdf080e?w=400&q=80','published',188),
  ('Pain Tradition','Traditional Algerian bread','6130002000016','Boulangerie Locale','Food','piece','https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=80','published',76),
  ('Huile Elio 5L','Vegetable cooking oil','6130002000023','Cevital Group','Food','5L Bidon','https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=400&q=80','published',134),
  ('Semoule SIM 1kg','Fine durum wheat semolina','6130002000030','Groupe SIM','Food','1kg Pack','https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=80','published',119),
  ('Tomate Concentrée Cojek 400g','Double-concentrated tomato paste','6130002000047','Cojek','Food','400g Tin','https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?w=400&q=80','published',88),
  ('Pâtes Tria 500g','Spaghetti pasta','6130002000054','Tria','Food','500g Pack','https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=80','draft',0),
  ('Lait Candia 1L','Full cream UHT milk','6130003000015','Candia Algérie','Dairy','1L Carton','https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400&q=80','published',156),
  ('Yaourt Soummam','Plain stirred yogurt','6130003000022','Soummam','Dairy','125g','https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400&q=80','published',143),
  ('Fromage La Vache Qui Rit','Processed cheese portions','6130003000039','Bel Group','Dairy','16 portions','https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400&q=80','published',109),
  ('Danette Djurdjura','Chocolate dessert cream','6130003000046','Danone Djurdjura','Dairy','4 x 100g','https://images.unsplash.com/photo-1563636619-e9143da7973b?w=400&q=80','archived',12),
  ('Biscuits Bimo Choco','Chocolate-filled biscuits pack','6130004000014','Bimo SPA','Snacks','pack','https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=80','published',92),
  ('Gaufrette Palmary','Vanilla wafer biscuits','6130004000021','Palmary','Snacks','pack','https://images.unsplash.com/photo-1509440159596-0249088772ff?w=400&q=80','published',64),
  ('Tomates Fraîches','Fresh local tomatoes','6130005000013','Producteur Local','Fresh','1kg','https://images.unsplash.com/photo-1610832958506-aa56368176cf?w=400&q=80','published',47),
  ('Pommes de Terre','Fresh potatoes','6130005000020','Producteur Local','Fresh','1kg','https://images.unsplash.com/photo-1610832958506-aa56368176cf?w=400&q=80','published',53),
  ('Détergent Isis 5kg','Laundry washing powder','6130006000012','Henkel Algérie','Household','5kg','https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=400&q=80','published',71),
  ('Eau de Javel 1L','Bleach disinfectant','6130006000029','Henkel Algérie','Household','1L Bottle','https://images.unsplash.com/photo-1583947215259-38e31be8751f?w=400&q=80','draft',0)
) AS s(name,description,barcode,brand,category,unit,photo_url,status,store_count)
WHERE NOT EXISTS (SELECT 1 FROM "library_products");
