// Pure Blink Cash rules (fees, limits, offer bonus, agent cash capacity),
// kept free of I/O so they are unit-testable (see blink-cash-rules.test.ts).
// Used by the /transactions create routes, the process route and /agents/dues.
// The settings they read live in blink_cash_settings (lib/blink-cash-settings.ts).

const ALGIERS_OFFSET_MS = 60 * 60 * 1000; // UTC+1, no DST

export const round2 = (n: number) => Math.round(n * 100) / 100;

export type CashType = "deposit" | "withdrawal";

/** The slice of blink_cash_settings the rules need. */
export interface CashRules {
  deposit_fee_rate: number;
  withdrawal_fee_rate: number;
  min_amount: number;
  max_amount: number;
  daily_deposit_limit: number;
  daily_withdrawal_limit: number;
  monthly_deposit_limit: number;
  monthly_withdrawal_limit: number;
  pending_expiry_minutes: number;
}

/** The fee on `amount` (whole dinars, as the app shows it). */
export function feeFor(type: CashType, amount: number, rules: Pick<CashRules, "deposit_fee_rate" | "withdrawal_fee_rate">) {
  const rate = type === "deposit" ? rules.deposit_fee_rate : rules.withdrawal_fee_rate;
  return Math.round(amount * rate);
}

/** What the rider pays (deposit: amount + fee) or receives in cash (withdrawal: amount - fee). */
export function totalFor(type: CashType, amount: number, fees: number) {
  return type === "deposit" ? amount + fees : amount - fees;
}

/** ISO instant a pending request lapses. */
export function expiresAtFor(minutes: number, now: Date = new Date()) {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/** ISO instant of the Algiers midnight that starts `now`'s day. */
export function algiersDayStartIso(now: Date = new Date()) {
  const local = new Date(now.getTime() + ALGIERS_OFFSET_MS);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return new Date(midnight - ALGIERS_OFFSET_MS).toISOString();
}

/** ISO instant of the Algiers midnight that starts `now`'s month. */
export function algiersMonthStartIso(now: Date = new Date()) {
  const local = new Date(now.getTime() + ALGIERS_OFFSET_MS);
  const first = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1);
  return new Date(first - ALGIERS_OFFSET_MS).toISOString();
}

export const LIMIT_CODES = ["limit_min", "limit_max", "limit_daily", "limit_monthly"] as const;
export type LimitCode = (typeof LIMIT_CODES)[number];
export interface LimitBreach {
  code: LimitCode;
  limit: number;
  used: number;
}

/**
 * First limit `amount` breaks, or null. `usedToday` / `usedMonth` are the sums
 * of the user's pending + review + completed operations of this type in the
 * current Algiers day / month, WITHOUT this request.
 */
export function checkLimits(
  type: CashType,
  amount: number,
  rules: CashRules,
  usedToday: number,
  usedMonth: number
): LimitBreach | null {
  if (amount < rules.min_amount) return { code: "limit_min", limit: rules.min_amount, used: 0 };
  if (amount > rules.max_amount) return { code: "limit_max", limit: rules.max_amount, used: 0 };
  const daily = type === "deposit" ? rules.daily_deposit_limit : rules.daily_withdrawal_limit;
  if (usedToday + amount > daily) return { code: "limit_daily", limit: daily, used: usedToday };
  const monthly = type === "deposit" ? rules.monthly_deposit_limit : rules.monthly_withdrawal_limit;
  if (usedMonth + amount > monthly) return { code: "limit_monthly", limit: monthly, used: usedMonth };
  return null;
}

// ─── Offers ──────────────────────────────────────────────────────────

export interface OfferRow {
  id: string;
  min_deposit: number;
  bonus_type: "fixed" | "percent";
  /** DA for fixed, percentage (10 = 10 %) for percent. */
  bonus_value: number;
  max_bonus: number | null;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
  per_user_limit: number | null;
  budget: number | null;
  used_amount: number;
}

/** The bonus a deposit of `amount` earns on `offer` (before budget / per-user checks). */
export function bonusFor(offer: Pick<OfferRow, "bonus_type" | "bonus_value" | "max_bonus">, amount: number) {
  let bonus = offer.bonus_type === "fixed" ? offer.bonus_value : round2((amount * offer.bonus_value) / 100);
  if (offer.max_bonus != null) bonus = Math.min(bonus, offer.max_bonus);
  return Math.max(0, bonus);
}

export type OfferRefusal =
  | "offer_inactive"
  | "offer_not_started"
  | "offer_ended"
  | "offer_min_deposit"
  | "offer_limit_reached"
  | "offer_budget_exhausted";

/**
 * Whether `offer` can still apply to a deposit of `amount`; `userUses` is how
 * many bonuses this rider already earned from it. Mirrors the SQL in
 * blink_cash_settle, which re-checks at completion.
 */
export function offerRefusal(
  offer: OfferRow,
  amount: number,
  userUses: number,
  now: Date = new Date()
): OfferRefusal | null {
  if (!offer.active) return "offer_inactive";
  if (offer.starts_at && Date.parse(offer.starts_at) > now.getTime()) return "offer_not_started";
  if (offer.ends_at && Date.parse(offer.ends_at) <= now.getTime()) return "offer_ended";
  if (amount < offer.min_deposit) return "offer_min_deposit";
  if (offer.per_user_limit != null && userUses >= offer.per_user_limit) return "offer_limit_reached";
  if (offer.budget != null && offer.used_amount + bonusFor(offer, amount) > offer.budget) {
    return "offer_budget_exhausted";
  }
  return null;
}

// ─── Agent cash limit ────────────────────────────────────────────────

/** The agent's limit: their own, else the settings default. */
export function agentLimit(profileLimit: number | null | undefined, defaultLimit: number) {
  return profileLimit != null && Number.isFinite(Number(profileLimit)) ? Number(profileLimit) : defaultLimit;
}

/** Room left under the limit (never negative). */
export function agentCapacity(totalDues: number, limit: number) {
  return round2(Math.max(0, limit - totalDues));
}

/** Confirming a deposit adds its amount to the agent's dues; withdrawals reduce them. */
export function breachesAgentLimit(type: CashType, totalDues: number, amount: number, limit: number) {
  return type === "deposit" && totalDues + amount > limit;
}

/** Share of the limit used, 0..n (Infinity-safe: a zero limit is fully used). */
export function limitUsage(totalDues: number, limit: number) {
  if (limit <= 0) return totalDues > 0 ? 1 : 0;
  return totalDues / limit;
}

export const AGENT_LIMIT_WARNING_RATIO = 0.8;
export const isNearLimit = (totalDues: number, limit: number) =>
  limit > 0 && limitUsage(totalDues, limit) >= AGENT_LIMIT_WARNING_RATIO;
