import { sql } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  index,
  pgPolicy,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { addressType } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

export const addresses = pgTable(
  "addresses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    address: text("address").notNull(),
    type: addressType("type").notNull().default("other"),
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
    street: text("street"),
    streetNumber: text("street_number"),
    floorApt: text("floor_apt"),
    directions: text("directions"),
    isDefault: boolean("is_default").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("idx_addresses_user").on(t.userId),
    pgPolicy("addresses_all_own", { for: "all", using: sql`auth.uid() = user_id` }),
  ]
);
