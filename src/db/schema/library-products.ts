import { index, integer, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { timestamps } from "./_shared";

// published|draft|archived — only `published` items surface to merchants in the
// app's Blink Library picker. Lives here so it ships in the additive migration.
export const libraryProductStatus = pgEnum("library_product_status", [
  "published",
  "draft",
  "archived",
]);

// The Blink Library master catalog. Mirrors the mobile app's BlinkLibraryProduct
// (blink/store/merchant/merchant-store.ts) plus admin lifecycle/metric fields.
// `name`/`description` are trilingual: one column per language (en/fr/ar), entered
// by the admin in the dashboard (00008_library_i18n.sql). `category` is denormalized
// to the category's ENGLISH name (name_en) — the language-stable key; the dashboard
// keeps products in sync when a category is renamed (see library/action.ts).
export const libraryProducts = pgTable(
  "library_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nameEn: text("name_en").notNull().default(""),
    nameFr: text("name_fr").notNull().default(""),
    nameAr: text("name_ar").notNull().default(""),
    descriptionEn: text("description_en").notNull().default(""),
    descriptionFr: text("description_fr").notNull().default(""),
    descriptionAr: text("description_ar").notNull().default(""),
    barcode: text("barcode").notNull().default(""), // EAN-13 — Algeria's GS1 prefix is 613
    brand: text("brand").notNull().default(""),
    category: text("category").notNull().default(""), // references library_categories.name_en
    unit: text("unit").notNull().default(""),
    // Up to 5 public URLs in the `library` Storage bucket; photos[0] is the cover.
    photos: text("photos").array().notNull().default(sql`'{}'::text[]`),
    status: libraryProductStatus("status").notNull().default("draft"),
    storeCount: integer("store_count").notNull().default(0), // merchant stores stocking this item
    ...timestamps,
  },
  (t) => [
    index("idx_library_products_status").on(t.status),
    index("idx_library_products_category").on(t.category),
  ]
);
