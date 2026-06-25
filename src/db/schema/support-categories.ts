import { sql } from "drizzle-orm";
import { index, integer, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";

// A help-center topic tile / FAQ group. Each role sees the categories whose
// target_roles include its label (or "All"). Labels are trilingual.
export const supportCategories = pgTable(
  "support_categories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(), // stable slug e.g. "account", "store", "payouts"
    targetRoles: text("target_roles").array().notNull().default(["All"]), // ["All"] | ["Customer"] | ["Rider","Merchant"] …
    labelEng: text("label_eng").notNull(),
    labelFr: text("label_fr"),
    labelAr: text("label_ar"),
    icon: text("icon").notNull().default("questionmark.circle"),
    color: text("color").notNull().default("#3B82F6"),
    sort: integer("sort").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    index("idx_support_categories_sort").on(t.sort),
    // Categories carry no sensitive data — readable by any authenticated client.
    pgPolicy("support_categories_select_all", { for: "select", using: sql`true` }),
  ]
);
