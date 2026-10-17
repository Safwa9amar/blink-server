import { sql } from "drizzle-orm";
import { index, numeric, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";
import { orders } from "./orders";
import { customerCoupons } from "./promotions";

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const referrals = pgTable(
  "referrals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    referrerId: uuid("referrer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    referredId: uuid("referred_id")
      .references(() => users.id, { onDelete: "set null" }),
    referralCode: text("referral_code").notNull(),
    status: text("status").notNull().default("pending"),
    rewardAmount: money("reward_amount").notNull().default(500),
    discountAmount: money("discount_amount").notNull().default(500),
    serviceType: text("service_type").notNull().default("delivery"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    couponId: uuid("coupon_id").references(() => customerCoupons.id, { onDelete: "set null" }),
    friendName: text("friend_name"),
    friendPhone: text("friend_phone"),
    completedAt: ts("completed_at"),
    ...timestamps,
  },
  (t) => [
    unique("referrals_referred_unique").on(t.referredId),
    index("idx_referrals_referrer").on(t.referrerId),
    index("idx_referrals_referred").on(t.referredId),
    index("idx_referrals_code").on(t.referralCode),
    pgPolicy("referrals_select_own", {
      for: "select",
      using: sql`auth.uid() = referrer_id OR auth.uid() = referred_id`,
    }),
  ]
);

export type Referral = typeof referrals.$inferSelect;
export type NewReferral = typeof referrals.$inferInsert;
