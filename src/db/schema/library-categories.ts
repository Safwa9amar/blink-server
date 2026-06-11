import { index, integer, pgEnum, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";

// active|inactive — only active categories surface to merchants in the app's
// Blink Library picker. Lives here (not enums.ts) so it ships in the additive
// `library` migration rather than the baseline snapshot.
export const libraryCategoryStatus = pgEnum("library_category_status", ["active", "inactive"]);

// Admin-managed product categories for the Blink Library (the platform-curated
// master catalog merchants pull from). Mirrors the dashboard's LibraryCategory
// type (blink-dashboard/src/features/library/types.ts). The display name is
// trilingual (one column per language, see 00008_library_i18n.sql); products
// reference a category by its ENGLISH name (name_en — the language-stable key,
// see library-products.ts).
export const libraryCategories = pgTable(
  "library_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nameEn: text("name_en").notNull().default("").unique(), // canonical name AND the value products reference
    nameFr: text("name_fr").notNull().default(""),
    nameAr: text("name_ar").notNull().default(""),
    slug: text("slug").notNull().unique(),
    icon: text("icon").notNull().default("grid"), // DashIcon name
    status: libraryCategoryStatus("status").notNull().default("active"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("idx_library_categories_status").on(t.status)]
);
