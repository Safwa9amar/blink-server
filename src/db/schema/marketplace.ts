import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgTable,
  real,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Customer-facing marketplace: categories → stores → products. Mirrors the
// mobile app's MarketplaceCategory / MarketplaceStore / MarketplaceProduct
// (blink/types/marketplace.types.ts). Catalog rows are public-read for any
// signed-in user; writes are server-side (service role) — 00032_marketplace.sql.

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

// `under_review` = merchant-created, awaiting staff approval (00035_merchant.sql).
export const storeStatus = pgEnum("store_status", ["active", "inactive", "under_review"]);
// Manual merchant products need staff review before customers see them.
export const productReviewStatus = pgEnum("product_review_status", [
  "approved",
  "pending",
  "rejected",
]);
export const priceSuggestionStatus = pgEnum("price_suggestion_status", [
  "pending",
  "accepted",
  "rejected",
]);

export interface StoreMenuCategory {
  id: string;
  title: string;
}

export interface StoreShift {
  open: string; // "HH:MM"
  close: string; // "HH:MM"
}

/** Weekly opening hours keyed by day (sat..fri) — mirrors the app's WeekHours. */
export type StoreWeekHours = Record<string, { enabled: boolean; shifts: StoreShift[] }>;

export interface StoreAdditionalDoc {
  id: string;
  name: string;
  url: string;
}

export interface StoreDocuments {
  commercial_register_front_url?: string | null;
  commercial_register_back_url?: string | null;
  nif?: string;
  nis?: string;
  additional_docs?: StoreAdditionalDoc[];
}

/** One staff verdict in `stores.document_review` (src/lib/store-documents.ts). */
export interface StoreDocumentReviewEntry {
  status: "verified" | "rejected";
  reason: string | null;
  /** The document value staff looked at (scan URL, or the NIF / NIS number). */
  value: string;
  reviewed_at: string;
  reviewed_by: string | null;
}

/** Keyed by commercial_register_front | commercial_register_back | nif | nis. */
export type StoreDocumentReview = Partial<
  Record<"commercial_register_front" | "commercial_register_back" | "nif" | "nis", StoreDocumentReviewEntry>
>;

export const marketplaceCategories = pgTable(
  "marketplace_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Stable key stores reference (stores.category_slugs) and the app routes on.
    slug: text("slug").notNull().unique(),
    // i18n key resolved by the app, e.g. "marketplace.categories.restaurant".
    labelKey: text("label_key").notNull(),
    icon: text("icon").notNull().default("square.grid.2x2"),
    bgColor: text("bg_color").notNull().default("#F2F2F7"),
    iconColor: text("icon_color").notNull().default("#8E8E93"),
    sortOrder: integer("sort_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  () => [
    pgPolicy("marketplace_categories_select_all", {
      for: "select",
      using: sql`auth.role() = 'authenticated'`,
    }),
  ]
);

export const stores = pgTable(
  "stores",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The merchant who runs it; null for platform-seeded stores.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    image: text("image").notNull().default(""),
    rating: real("rating").notNull().default(0),
    reviewCount: integer("review_count").notNull().default(0),
    location: text("location"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    openingHours: text("opening_hours"),
    isOpen: boolean("is_open").notNull().default(true),
    deliveryFee: money("delivery_fee").notNull().default(0),
    deliveryTime: text("delivery_time"),
    minOrder: money("min_order").notNull().default(0),
    categorySlugs: text("category_slugs").array().notNull().default(sql`'{}'::text[]`),
    isFeatured: boolean("is_featured").notNull().default(false),
    isSupermarket: boolean("is_supermarket").notNull().default(false),
    menuCategories: jsonb("menu_categories").$type<StoreMenuCategory[]>().notNull().default([]),
    status: storeStatus("status").notNull().default("active"),
    // Merchant-managed fields (00035_merchant.sql).
    description: text("description"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    email: text("email"),
    logo: text("logo"),
    // Extra storefront photos (the cover is `image`).
    gallery: text("gallery").array().notNull().default(sql`'{}'::text[]`),
    city: text("city"),
    wilaya: text("wilaya"),
    hours: jsonb("hours").$type<StoreWeekHours>(),
    documents: jsonb("documents").$type<StoreDocuments>().notNull().default({}),
    manualOverride: boolean("manual_override").notNull().default(false),
    isPrimary: boolean("is_primary").notNull().default(false),
    // Weekly revenue goal (Strategy → Weekly Goal), 00036_merchant_flows.sql.
    weeklyGoal: money("weekly_goal").notNull().default(0),
    // Why staff rejected / deactivated the store — shown to the merchant, kept
    // while they resubmit, cleared on approval. Null on an inactive store = hidden
    // for another reason (20261010144215_store_review_note.sql, src/lib/store-review.ts).
    reviewNote: text("review_note"),
    // Staff's verdict per required document, valid only while it matches the
    // current value in `documents` (20261010163208_store_document_review.sql,
    // src/lib/store-documents.ts). Server-written only; never sent to the
    // merchant raw (they get the computed `documents_status`).
    documentReview: jsonb("document_review").$type<StoreDocumentReview>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index("idx_stores_owner").on(t.ownerId),
    index("idx_stores_status").on(t.status),
    index("idx_stores_category_slugs").using("gin", t.categorySlugs),
    pgPolicy("stores_select_active", {
      for: "select",
      using: sql`status = 'active' OR auth.uid() = owner_id`,
    }),
  ]
);

export const storeProducts = pgTable(
  "store_products",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    price: money("price").notNull().default(0),
    image: text("image").notNull().default(""),
    tag: text("tag"),
    // Matches one of stores.menu_categories[].id.
    menuCategory: text("menu_category"),
    rating: real("rating"),
    unit: text("unit"),
    isAvailable: boolean("is_available").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    // Merchant catalog fields (00035_merchant.sql). `price` is the live
    // selling price; `blink_price` is Blink's reference price.
    barcode: text("barcode").notNull().default(""),
    brand: text("brand").notNull().default(""),
    category: text("category").notNull().default(""),
    stock: integer("stock").notNull().default(0),
    photos: text("photos").array().notNull().default(sql`'{}'::text[]`),
    // Plain uuid (FK in the migration) — library_products isn't in this barrel.
    libraryProductId: uuid("library_product_id"),
    reviewStatus: productReviewStatus("review_status").notNull().default("approved"),
    blinkPrice: money("blink_price").notNull().default(0),
    suggestedPrice: numeric("suggested_price", { precision: 10, scale: 2 }).$type<number>(),
    suggestionStatus: priceSuggestionStatus("suggestion_status"),
    // Why staff rejected the product or its price suggestion — shown to the
    // merchant, cleared when they resubmit (20261010130645_merchant_catalog_review.sql).
    reviewNote: text("review_note"),
    ...timestamps,
  },
  (t) => [
    index("idx_store_products_store").on(t.storeId),
    pgPolicy("store_products_select_all", {
      for: "select",
      using: sql`auth.role() = 'authenticated'`,
    }),
  ]
);
