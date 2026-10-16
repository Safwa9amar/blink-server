import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { userRole } from "./enums";
import { timestamps } from "./_shared";
import { transactions } from "./transactions";
import { users } from "./users";

// Full Blink Cash (20261016120000_blink_cash_full.sql): the wallet ledger,
// settings, deposit offers and the finance audit trail. Everything is written
// by blink-server (service role) through the blink_* SQL functions; riders may
// only select their own wallet and entries.

const money = (name: string) => numeric(name, { precision: 14, scale: 2 }).$type<number>();
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export interface LocalizedText {
  en?: string;
  fr?: string;
  ar?: string;
}

export interface ElectronicAccount {
  label: string;
  type: "ccp" | "baridimob" | "rip" | "bank";
  number: string;
  holder: string;
}

export interface DuesPaymentMethod {
  id: string;
  label: string;
}

/** One row per (user, role); only `rider` is used today. */
export const blinkWallets = pgTable(
  "blink_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: userRole("role").notNull(),
    balance: money("balance").notNull().default(0),
    /** Reserved by pending / in-review withdrawals (blink_wallet_holds). */
    held: money("held").notNull().default(0),
    status: text("status").$type<"active" | "frozen">().notNull().default("active"),
    frozenReason: text("frozen_reason"),
    frozenBy: uuid("frozen_by").references(() => users.id, { onDelete: "set null" }),
    frozenAt: ts("frozen_at"),
    /** Set by the one-off backfill; until then the balance is derived (riderWalletDerived). */
    backfilledAt: ts("backfilled_at"),
    ...timestamps,
  },
  (t) => [
    unique("blink_wallets_user_id_role_key").on(t.userId, t.role),
    check("blink_wallets_held_check", sql`held >= 0`),
    pgPolicy("blink_wallets_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
  ]
);

export const WALLET_ENTRY_KINDS = [
  "opening_balance",
  "deposit",
  "withdrawal",
  "trip",
  "challenge_reward",
  "offer_bonus",
  "adjustment",
  "reversal",
] as const;
export type WalletEntryKind = (typeof WALLET_ENTRY_KINDS)[number];

/** Append-only (a trigger rejects UPDATE / DELETE). */
export const blinkWalletEntries = pgTable(
  "blink_wallet_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => blinkWallets.id),
    kind: text("kind").$type<WalletEntryKind>().notNull(),
    amount: money("amount").notNull(),
    balanceAfter: money("balance_after").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    transactionId: uuid("transaction_id").references(() => transactions.id),
    refType: text("ref_type"),
    refId: text("ref_id"),
    memo: text("memo"),
    /** Staff user for adjustments / reversals. */
    actorId: uuid("actor_id"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_blink_wallet_entries_wallet").on(t.walletId, t.createdAt.desc()),
    pgPolicy("blink_wallet_entries_select_own", {
      for: "select",
      using: sql`exists (select 1 from blink_wallets w where w.id = wallet_id and w.user_id = auth.uid())`,
    }),
  ]
);

/** Funds a pending / in-review withdrawal reserves on the wallet. */
export const blinkWalletHolds = pgTable(
  "blink_wallet_holds",
  {
    transactionId: uuid("transaction_id")
      .primaryKey()
      .references(() => transactions.id),
    walletId: uuid("wallet_id")
      .notNull()
      .references(() => blinkWallets.id),
    amount: money("amount").notNull(),
    status: text("status").$type<"active" | "released" | "captured">().notNull().default("active"),
    createdAt: ts("created_at").notNull().defaultNow(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [index("idx_blink_wallet_holds_wallet").on(t.walletId)]
);

/** Single row (id is always true). */
export const blinkCashSettings = pgTable("blink_cash_settings", {
  id: boolean("id").primaryKey().default(true),
  depositFeeRate: numeric("deposit_fee_rate", { precision: 6, scale: 4 }).$type<number>().notNull().default(0.02),
  withdrawalFeeRate: numeric("withdrawal_fee_rate", { precision: 6, scale: 4 }).$type<number>().notNull().default(0.02),
  minAmount: money("min_amount").notNull().default(1000),
  maxAmount: money("max_amount").notNull().default(100000),
  dailyDepositLimit: money("daily_deposit_limit").notNull().default(200000),
  dailyWithdrawalLimit: money("daily_withdrawal_limit").notNull().default(100000),
  monthlyDepositLimit: money("monthly_deposit_limit").notNull().default(1000000),
  monthlyWithdrawalLimit: money("monthly_withdrawal_limit").notNull().default(500000),
  pendingExpiryMinutes: integer("pending_expiry_minutes").notNull().default(15),
  agentCreditLimit: money("agent_credit_limit").notNull().default(200000),
  electronicEnabled: boolean("electronic_enabled").notNull().default(false),
  electronicAccounts: jsonb("electronic_accounts").$type<ElectronicAccount[]>().notNull().default([]),
  requirePinForWithdrawal: boolean("require_pin_for_withdrawal").notNull().default(false),
  quickAmounts: integer("quick_amounts").array().notNull().default(sql`'{1000,2000,5000,10000}'`),
  duesPaymentMethods: jsonb("dues_payment_methods").$type<DuesPaymentMethod[]>().notNull(),
  adjustLimitFinanceAdmin: money("adjust_limit_finance_admin").notNull().default(50000),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** `bonus_value` is DA for 'fixed', a percentage (10 = 10 %) for 'percent'. */
export const blinkCashOffers = pgTable(
  "blink_cash_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: jsonb("title").$type<LocalizedText>().notNull().default({}),
    description: jsonb("description").$type<LocalizedText>().notNull().default({}),
    minDeposit: money("min_deposit").notNull().default(0),
    bonusType: text("bonus_type").$type<"fixed" | "percent">().notNull(),
    bonusValue: money("bonus_value").notNull(),
    maxBonus: money("max_bonus"),
    startsAt: ts("starts_at"),
    endsAt: ts("ends_at"),
    active: boolean("active").notNull().default(true),
    perUserLimit: integer("per_user_limit").default(1),
    budget: money("budget"),
    usedCount: integer("used_count").notNull().default(0),
    usedAmount: money("used_amount").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("idx_blink_cash_offers_active").on(t.active, t.endsAt)]
);

/** Every staff write on Blink Cash. Service-role only. */
export const financeAuditEvents = pgTable(
  "finance_audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    amount: money("amount"),
    reason: text("reason"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_finance_audit_created").on(t.createdAt.desc()),
    index("idx_finance_audit_actor").on(t.actorId),
    index("idx_finance_audit_target").on(t.targetType, t.targetId),
  ]
);
