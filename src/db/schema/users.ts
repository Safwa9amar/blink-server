import { sql } from "drizzle-orm";
import { date, index, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { gender, userRole } from "./enums";
import { timestamps } from "./_shared";

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().default(sql`auth.uid()`),
    // Nullable: OAuth (Google) users authenticate by email and have no phone.
    // Nullable-unique is valid in Postgres (multiple NULLs allowed).
    phoneNumber: text("phone_number").unique(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    middleName: text("middle_name"),
    email: text("email"),
    role: userRole("role").notNull().default("customer"),
    gender: gender("gender"),
    birthday: date("birthday"),
    profilePicture: text("profile_picture"),
    // Common/repeated fields shared across roles live here (not duplicated in
    // role tables): address, home province, payout account.
    address: text("address"),
    wilaya: text("wilaya"),
    wilayaCode: text("wilaya_code"),
    bankRib: text("bank_rib"),
    pinHash: text("pin_hash"),
    ...timestamps,
  },
  (t) => [
    index("idx_users_phone").on(t.phoneNumber),
    index("idx_users_role").on(t.role),
    pgPolicy("users_select_own", { for: "select", using: sql`auth.uid() = id` }),
    pgPolicy("users_update_own", { for: "update", using: sql`auth.uid() = id` }),
  ]
);
