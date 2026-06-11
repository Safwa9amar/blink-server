import { sql } from "drizzle-orm";
import {
  doublePrecision,
  index,
  integer,
  numeric,
  pgPolicy,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { disputeStatus, tripStatus } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

// numeric() infers `string`; both apps read via supabase-js (PostgREST returns
// these as JSON numbers), so we surface them as `number` to match.
const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    displayId: text("display_id").notNull().unique(),
    riderId: uuid("rider_id")
      .notNull()
      .references(() => users.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => users.id),
    status: tripStatus("status").notNull().default("upcoming"),
    pickupLabel: text("pickup_label").notNull(),
    pickupAddress: text("pickup_address").notNull(),
    pickupLat: doublePrecision("pickup_lat").notNull(),
    pickupLng: doublePrecision("pickup_lng").notNull(),
    dropoffLabel: text("dropoff_label").notNull(),
    dropoffAddress: text("dropoff_address").notNull(),
    dropoffLat: doublePrecision("dropoff_lat").notNull(),
    dropoffLng: doublePrecision("dropoff_lng").notNull(),
    estimatedPayout: money("estimated_payout").notNull(),
    netPayout: money("net_payout").notNull(),
    distanceKm: numeric("distance_km", { precision: 6, scale: 2 }).$type<number>().notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    cancellationReason: text("cancellation_reason"),
    notes: text("notes"),
    penaltyAmount: money("penalty_amount"),
    disputeStatus: disputeStatus("dispute_status"),
    fraudNotice: text("fraud_notice"),
    ...timestamps,
  },
  (t) => [
    index("idx_trips_rider").on(t.riderId),
    index("idx_trips_customer").on(t.customerId),
    index("idx_trips_status").on(t.status),
    pgPolicy("trips_select_own", {
      for: "select",
      using: sql`auth.uid() = rider_id OR auth.uid() = customer_id`,
    }),
  ]
);
