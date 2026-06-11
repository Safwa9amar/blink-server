import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, unique, uuid } from "drizzle-orm/pg-core";
import { documentStatus, vehicleCategory } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

export const vehicles = pgTable(
  "vehicles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    brand: text("brand").notNull(),
    model: text("model").notNull(),
    licensePlate: text("license_plate").notNull(),
    year: text("year").notNull(),
    color: text("color").notNull(),
    category: vehicleCategory("category").notNull().default("standard"),
    grayCardUrl: text("gray_card_url"),
    grayCardStatus: documentStatus("gray_card_status").notNull().default("not_uploaded"),
    insuranceUrl: text("insurance_url"),
    insuranceStatus: documentStatus("insurance_status").notNull().default("not_uploaded"),
    drivingLicenseUrl: text("driving_license_url"),
    drivingLicenseStatus: documentStatus("driving_license_status")
      .notNull()
      .default("not_uploaded"),
    ...timestamps,
  },
  (t) => [
    unique("vehicles_user_id_key").on(t.userId),
    index("idx_vehicles_user").on(t.userId),
    pgPolicy("vehicles_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
    pgPolicy("vehicles_all_own", { for: "all", using: sql`auth.uid() = user_id` }),
  ]
);
