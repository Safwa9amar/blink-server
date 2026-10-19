import { sql } from "drizzle-orm";
import {
  check,
  index,
  numeric,
  pgPolicy,
  pgTable,
  smallint,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { agentShops } from "./agent-shops";
import { depositMethod, transactionStatus, transactionType } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: transactionType("type").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id), // rider or agent
    agentId: uuid("agent_id").references(() => users.id), // agent who processed it
    riderId: uuid("rider_id").references(() => users.id), // rider involved
    // Agent shop the operation went through (set when the agent processes it).
    shopId: uuid("shop_id").references(() => agentShops.id, { onDelete: "set null" }),
    amount: money("amount").notNull(),
    fees: money("fees").notNull().default(0),
    total: money("total").notNull(),
    status: transactionStatus("status").notNull().default("pending"),
    method: depositMethod("method"),
    pendingId: uuid("pending_id").unique(), // QR pending reference
    offerTitle: text("offer_title"),
    offerDetail: text("offer_detail"),
    rating: smallint("rating"), // rider → agent
    feedback: text("feedback"),
    // Agent → rider rating, left on the receipt after an operation (20261006230006_agent_backend.sql).
    riderRating: smallint("rider_rating"),
    riderFeedback: text("rider_feedback"),
    // Rates in force (20261018120000_pricing_config.sql): fee_rate is set at
    // creation, platform_share_rate / tax_rate when the agent processes it.
    feeRate: numeric("fee_rate", { precision: 6, scale: 4 }).$type<number>(),
    platformShareRate: numeric("platform_share_rate", { precision: 6, scale: 4 }).$type<number>(),
    taxRate: numeric("tax_rate", { precision: 6, scale: 4 }).$type<number>(),
    ...timestamps,
  },
  (t) => [
    index("idx_transactions_user").on(t.userId),
    index("idx_transactions_agent").on(t.agentId),
    index("idx_transactions_rider").on(t.riderId),
    index("idx_transactions_shop").on(t.shopId),
    index("idx_transactions_status").on(t.status),
    index("idx_transactions_pending")
      .on(t.pendingId)
      .where(sql`pending_id IS NOT NULL`),
    check("transactions_rating_check", sql`rating >= 1 AND rating <= 5`),
    check("transactions_rider_rating_check", sql`rider_rating >= 1 AND rider_rating <= 5`),
    pgPolicy("transactions_select_own", {
      for: "select",
      using: sql`auth.uid() = user_id OR auth.uid() = agent_id`,
    }),
  ]
);
