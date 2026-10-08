import { index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { orders } from "./orders";
import { users } from "./users";

// Orders a rider turned down — an offer they declined, or a job they dropped
// after accepting (00037_rider_dispatch.sql). Dispatch never re-offers them.
export const riderOrderDeclines = pgTable(
  "rider_order_declines",
  {
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    riderId: uuid("rider_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    stage: text("stage").$type<"offer" | "post_accept">().notNull().default("offer"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.riderId] }),
    index("idx_rider_order_declines_rider").on(t.riderId),
  ]
);
