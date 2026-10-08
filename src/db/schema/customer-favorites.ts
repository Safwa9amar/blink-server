import { sql } from "drizzle-orm";
import { index, pgEnum, pgPolicy, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { users } from "./users";

// A customer's saved stores / products (Profile → Favorites, heart buttons).
// `target_id` is a stores.id or store_products.id depending on `target_type`
// — polymorphic, so no FK; the list endpoint drops dangling ids.
export const favoriteTarget = pgEnum("favorite_target", ["store", "product"]);

export const customerFavorites = pgTable(
  "customer_favorites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    targetType: favoriteTarget("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("customer_favorites_user_target_key").on(t.userId, t.targetType, t.targetId),
    index("idx_customer_favorites_user").on(t.userId),
    pgPolicy("customer_favorites_all_own", { for: "all", using: sql`auth.uid() = user_id` }),
  ]
);
