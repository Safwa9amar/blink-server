import { sql } from "drizzle-orm";
import { boolean, index, jsonb, numeric, pgPolicy, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { paymentProvider, paymentPurpose, paymentStatus } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

// Online payment gateways (20261020120000_payment_gateways.sql): one `payments`
// row per gateway checkout (a rider wallet top-up or an agent / merchant dues
// payment), `payment_events` for webhook idempotency. Written by the server
// (service role) only; users read their own payments.

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    purpose: paymentPurpose("purpose").notNull(),
    // transactions.id / agent_dues_payments.id / merchant_dues_payments.id (by purpose).
    refId: uuid("ref_id").notNull(),
    provider: paymentProvider("provider").notNull(),
    method: text("method").notNull(),
    // What the card is charged (identical to what the provider is asked for).
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("DZD"),
    status: paymentStatus("status").notNull().default("pending"),
    providerRef: text("provider_ref"),
    checkoutUrl: text("checkout_url"),
    livemode: boolean("livemode").notNull().default(false),
    failureReason: text("failure_reason"),
    paidAt: timestamp("paid_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true, mode: "string" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payments_provider_ref_key").on(t.provider, t.providerRef),
    index("idx_payments_purpose_ref").on(t.purpose, t.refId),
    index("idx_payments_status_expires").on(t.status, t.expiresAt),
    index("idx_payments_user").on(t.userId, t.createdAt.desc()),
    pgPolicy("payments_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
  ]
);

// Webhook idempotency + audit: unique (provider, event_id). Service role only.
export const paymentEvents = pgTable(
  "payment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: paymentProvider("provider").notNull(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("payment_events_provider_event_key").on(t.provider, t.eventId),
    index("idx_payment_events_payment").on(t.paymentId),
  ]
).enableRLS();
