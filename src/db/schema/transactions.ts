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
    amount: money("amount").notNull(),
    fees: money("fees").notNull().default(0),
    total: money("total").notNull(),
    status: transactionStatus("status").notNull().default("pending"),
    method: depositMethod("method"),
    pendingId: uuid("pending_id").unique(), // QR pending reference
    offerTitle: text("offer_title"),
    offerDetail: text("offer_detail"),
    rating: smallint("rating"),
    feedback: text("feedback"),
    ...timestamps,
  },
  (t) => [
    index("idx_transactions_user").on(t.userId),
    index("idx_transactions_agent").on(t.agentId),
    index("idx_transactions_rider").on(t.riderId),
    index("idx_transactions_status").on(t.status),
    index("idx_transactions_pending")
      .on(t.pendingId)
      .where(sql`pending_id IS NOT NULL`),
    check("transactions_rating_check", sql`rating >= 1 AND rating <= 5`),
    pgPolicy("transactions_select_own", {
      for: "select",
      using: sql`auth.uid() = user_id OR auth.uid() = agent_id`,
    }),
  ]
);
