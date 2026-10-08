import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { transactionStatus } from "./enums";
import { timestamps } from "./_shared";
import { users } from "./users";

// Agent-side tables (20261006230006_agent_backend.sql): Blink Cash dues payments and the
// agent perks (partner benefits + operation challenges) shown under Profile.
// Agents read/write them through blink-server (/agents/*) — see
// src/lib/agent-finance.ts for how dues are derived.

const money = (name: string) => numeric(name, { precision: 10, scale: 2 }).$type<number>();

/** An agent settling the cash they owe Blink (see computeAgentDues). */
export const agentDuesPayments = pgTable(
  "agent_dues_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    amount: money("amount").notNull(),
    /** Payment-processing fee charged on top of `amount`. */
    fees: money("fees").notNull().default(0),
    method: text("method").notNull(),
    status: transactionStatus("status").notNull().default("completed"),
    ...timestamps,
  },
  (t) => [
    index("idx_agent_dues_agent").on(t.agentId),
    pgPolicy("agent_dues_select_own", { for: "select", using: sql`auth.uid() = agent_id` }),
  ]
);

export const agentBenefits = pgTable(
  "agent_benefits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerName: text("partner_name").notNull(),
    /** Short card headline ("15% Off Office Supplies"). */
    offerText: text("offer_text").notNull(),
    /** Detail-page title; falls back to offer_text. */
    offerTitle: text("offer_title"),
    subtext: text("subtext"),
    category: text("category").$type<"supplies" | "telecom" | "other">().notNull().default("other"),
    imageUrl: text("image_url"),
    aboutText: text("about_text"),
    redeemSteps: jsonb("redeem_steps").$type<string[]>().notNull().default([]),
    terms: jsonb("terms").$type<string[]>().notNull().default([]),
    phone: text("phone"),
    location: text("location"),
    validUntil: timestamp("valid_until", { withTimezone: true, mode: "string" }),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  () => [pgPolicy("agent_benefits_select_active", { for: "select", using: sql`is_active` })]
);

export const agentChallenges = pgTable(
  "agent_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    imageUrl: text("image_url"),
    rules: text("rules").notNull(),
    /** Credited against the agent's dues when the challenge is won. */
    rewardAmount: money("reward_amount").notNull(),
    /** Completed rider operations needed. */
    targetOperations: integer("target_operations").notNull(),
    /** Only count this kind of operation; null = deposits and withdrawals. */
    operationType: text("operation_type").$type<"deposit" | "withdrawal">(),
    /** Optional local-hour window an operation must be processed in. */
    hourFrom: smallint("hour_from"),
    hourTo: smallint("hour_to"),
    /** Cancelled operations allowed before the challenge is lost; null = no limit. */
    maxCancellations: integer("max_cancellations"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("idx_agent_challenges_ends").on(t.endsAt),
    pgPolicy("agent_challenges_select_active", { for: "select", using: sql`is_active` }),
  ]
);

export const agentChallengeParticipants = pgTable(
  "agent_challenge_participants",
  {
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => agentChallenges.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** joined → won | lost (settled by the server); gave_up when the agent quits. */
    status: text("status").$type<"joined" | "won" | "lost" | "gave_up">().notNull().default("joined"),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
    /** Reward credited on a win (counted by computeAgentDues / agent earnings). */
    rewardAmount: money("reward_amount"),
  },
  (t) => [
    primaryKey({ columns: [t.challengeId, t.agentId] }),
    index("idx_agent_challenge_participants_agent").on(t.agentId),
  ]
);
