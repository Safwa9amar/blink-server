// blink_cash_settings (single row): fees, limits, expiry, electronic flag, PIN
// requirement… Read through a 30 s in-process cache; the staff PUT calls
// invalidateBlinkCashSettings(). If the table is missing (migration not
// applied yet) the defaults below keep the old behaviour (2 % fee, agent only).
import type { CashRules } from "./blink-cash-rules";
import { supabaseAdmin } from "./supabase";

export interface ElectronicAccountRow {
  label: string;
  type: "ccp" | "baridimob" | "rip" | "bank";
  number: string;
  holder: string;
}

export interface BlinkCashSettings extends CashRules {
  agent_credit_limit: number;
  electronic_enabled: boolean;
  electronic_accounts: ElectronicAccountRow[];
  require_pin_for_withdrawal: boolean;
  quick_amounts: number[];
  dues_payment_methods: { id: string; label: string }[];
  adjust_limit_finance_admin: number;
}

export const DEFAULT_SETTINGS: BlinkCashSettings = {
  deposit_fee_rate: 0.02,
  withdrawal_fee_rate: 0.02,
  min_amount: 1000,
  max_amount: 100000,
  daily_deposit_limit: 200000,
  daily_withdrawal_limit: 100000,
  monthly_deposit_limit: 1000000,
  monthly_withdrawal_limit: 500000,
  pending_expiry_minutes: 15,
  agent_credit_limit: 200000,
  electronic_enabled: false,
  electronic_accounts: [],
  require_pin_for_withdrawal: false,
  quick_amounts: [1000, 2000, 5000, 10000],
  dues_payment_methods: [
    { id: "cash_office", label: "Cash at Blink office" },
    { id: "ccp", label: "CCP" },
    { id: "baridimob", label: "BaridiMob" },
  ],
  adjust_limit_finance_admin: 50000,
};

export const SETTINGS_TTL_MS = 30_000;

const NUMERIC_KEYS = [
  "deposit_fee_rate",
  "withdrawal_fee_rate",
  "min_amount",
  "max_amount",
  "daily_deposit_limit",
  "daily_withdrawal_limit",
  "monthly_deposit_limit",
  "monthly_withdrawal_limit",
  "pending_expiry_minutes",
  "agent_credit_limit",
  "adjust_limit_finance_admin",
] as const;

/** A DB row → settings, with numeric(…) values coerced and gaps filled from the defaults. */
export function normalizeSettings(row: Record<string, any> | null | undefined): BlinkCashSettings {
  const out: BlinkCashSettings = { ...DEFAULT_SETTINGS };
  if (!row) return out;
  for (const k of NUMERIC_KEYS) {
    const n = Number(row[k]);
    if (row[k] != null && Number.isFinite(n)) out[k] = n;
  }
  if (typeof row.electronic_enabled === "boolean") out.electronic_enabled = row.electronic_enabled;
  if (typeof row.require_pin_for_withdrawal === "boolean") {
    out.require_pin_for_withdrawal = row.require_pin_for_withdrawal;
  }
  if (Array.isArray(row.electronic_accounts)) out.electronic_accounts = row.electronic_accounts;
  if (Array.isArray(row.quick_amounts)) out.quick_amounts = row.quick_amounts.map(Number);
  if (Array.isArray(row.dues_payment_methods)) out.dues_payment_methods = row.dues_payment_methods;
  return out;
}

/** The subset every signed-in role may read (GET /blink-cash/settings). */
export function publicSettings(s: BlinkCashSettings) {
  return {
    deposit_fee_rate: s.deposit_fee_rate,
    withdrawal_fee_rate: s.withdrawal_fee_rate,
    min_amount: s.min_amount,
    max_amount: s.max_amount,
    quick_amounts: s.quick_amounts,
    pending_expiry_minutes: s.pending_expiry_minutes,
    electronic_enabled: s.electronic_enabled,
    electronic_accounts: s.electronic_accounts,
    require_pin_for_withdrawal: s.require_pin_for_withdrawal,
    dues_payment_methods: s.dues_payment_methods,
  };
}

let cache: { at: number; value: BlinkCashSettings } | null = null;

export function invalidateBlinkCashSettings() {
  cache = null;
}

export async function getBlinkCashSettings(now = Date.now()): Promise<BlinkCashSettings> {
  if (cache && now - cache.at < SETTINGS_TTL_MS) return cache.value;
  const { data, error } = await supabaseAdmin.from("blink_cash_settings").select("*").maybeSingle();
  if (error) {
    console.error("[blink-cash] settings read failed, using defaults", error.message);
    // Don't cache a failure for the full TTL.
    return cache?.value ?? DEFAULT_SETTINGS;
  }
  const value = normalizeSettings(data);
  cache = { at: now, value };
  return value;
}
