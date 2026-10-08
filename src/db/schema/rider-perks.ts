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
import { timestamps } from "./_shared";
import { users } from "./users";

// Rider perks (00038_rider_perks.sql): partner benefits and trip challenges
// shown under Profile → Benefits / Challenges. Content is staff-managed;
// riders read it through blink-server (/riders/benefits, /riders/challenges).

export const riderBenefits = pgTable(
  "rider_benefits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerName: text("partner_name").notNull(),
    /** Short card headline ("15% Off Oil Changes"). */
    offerText: text("offer_text").notNull(),
    /** Detail-page title; falls back to offer_text. */
    offerTitle: text("offer_title"),
    subtext: text("subtext"),
    category: text("category").$type<"fuel" | "maintenance" | "other">().notNull().default("other"),
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
  (t) => [
    pgPolicy("rider_benefits_select_active", { for: "select", using: sql`is_active` }),
  ]
);

export const riderChallenges = pgTable(
  "rider_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    imageUrl: text("image_url"),
    rules: text("rules").notNull(),
    /** Blink Cash credited when the rider completes the challenge. */
    rewardAmount: numeric("reward_amount", { precision: 10, scale: 2 }).$type<number>().notNull(),
    /** Completed trips needed. */
    targetTrips: integer("target_trips").notNull(),
    /** Optional local-hour window a trip must be created in (e.g. 0-10 = mornings). */
    hourFrom: smallint("hour_from"),
    hourTo: smallint("hour_to"),
    /** Canceled trips allowed before the challenge is lost; null = no limit. */
    maxCancellations: integer("max_cancellations"),
    startsAt: timestamp("starts_at", { withTimezone: true, mode: "string" }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true, mode: "string" }).notNull(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("idx_rider_challenges_ends").on(t.endsAt),
    pgPolicy("rider_challenges_select_active", { for: "select", using: sql`is_active` }),
  ]
);

export const riderChallengeParticipants = pgTable(
  "rider_challenge_participants",
  {
    challengeId: uuid("challenge_id")
      .notNull()
      .references(() => riderChallenges.id, { onDelete: "cascade" }),
    riderId: uuid("rider_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** joined → won | lost (settled by the server); gave_up when the rider quits. */
    status: text("status").$type<"joined" | "won" | "lost" | "gave_up">().notNull().default("joined"),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }).notNull().defaultNow(),
    settledAt: timestamp("settled_at", { withTimezone: true, mode: "string" }),
    /** Reward credited to Blink Cash on a win (counted by /riders/wallet). */
    rewardAmount: numeric("reward_amount", { precision: 10, scale: 2 }).$type<number>(),
  },
  (t) => [
    primaryKey({ columns: [t.challengeId, t.riderId] }),
    index("idx_rider_challenge_participants_rider").on(t.riderId),
  ]
);
