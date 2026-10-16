// Staff Blink Cash API (routes/blink-cash/admin-*.ts, agents / merchant admin dues).
// Settings columns and types follow spec 2026-10-16-blink-cash-full-design §3.
import { z } from "@hono/zod-openapi";

const money = z.number().finite();
const reason = z.string().trim().min(3).max(500);
const page = (name: string) => z.coerce.number().int().min(1).default(1).openapi({ param: { name, in: "query" } });

export const MAX_AMOUNT = 10_000_000;

// ─── Settings ────────────────────────────────────────────────────────

const rate = z.number().min(0).max(0.2);
const dzd = z.number().min(0).max(MAX_AMOUNT);

export const ElectronicAccount = z.object({
  label: z.string().trim().min(1).max(80),
  type: z.enum(["ccp", "baridimob", "rip", "bank"]),
  number: z.string().trim().min(1).max(64),
  holder: z.string().trim().min(1).max(120),
});

export const DuesPaymentMethod = z.object({
  id: z.string().trim().regex(/^[a-z0-9_-]{1,32}$/),
  label: z.string().trim().min(1).max(80),
});

export const BlinkCashSettingsFields = z.object({
  deposit_fee_rate: rate,
  withdrawal_fee_rate: rate,
  min_amount: dzd.min(1),
  max_amount: dzd.min(1),
  daily_deposit_limit: dzd,
  daily_withdrawal_limit: dzd,
  monthly_deposit_limit: dzd,
  monthly_withdrawal_limit: dzd,
  pending_expiry_minutes: z.number().int().min(1).max(1440),
  agent_credit_limit: dzd,
  electronic_enabled: z.boolean(),
  electronic_accounts: z.array(ElectronicAccount).max(10),
  require_pin_for_withdrawal: z.boolean(),
  quick_amounts: z.array(z.number().int().min(1).max(MAX_AMOUNT)).min(1).max(8),
  dues_payment_methods: z.array(DuesPaymentMethod).min(1).max(10),
  adjust_limit_finance_admin: dzd,
});
export type BlinkCashSettingsInput = z.infer<typeof BlinkCashSettingsFields>;

export const UpdateBlinkCashSettingsBody = BlinkCashSettingsFields.partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update")
  .openapi("UpdateBlinkCashSettings");

/** Cross-field rules on the settings AFTER the patch is merged in. */
export function settingsRuleIssues(s: Partial<BlinkCashSettingsInput>): string[] {
  const issues: string[] = [];
  const n = (v: unknown) => (typeof v === "number" ? v : undefined);
  const { min_amount: min, max_amount: max } = s;
  if (n(min) != null && n(max) != null && min! > max!) issues.push("min_amount must not exceed max_amount");
  for (const kind of ["deposit", "withdrawal"] as const) {
    const daily = n(s[`daily_${kind}_limit`]);
    const monthly = n(s[`monthly_${kind}_limit`]);
    if (daily != null && n(max) != null && daily < max!) issues.push(`daily_${kind}_limit must be at least max_amount`);
    if (daily != null && monthly != null && monthly < daily) issues.push(`monthly_${kind}_limit must be at least the daily limit`);
  }
  if (s.quick_amounts) {
    if (new Set(s.quick_amounts).size !== s.quick_amounts.length) issues.push("quick_amounts must be unique");
    if (n(min) != null && s.quick_amounts.some((a) => a < min!)) issues.push("quick_amounts must be at least min_amount");
    if (n(max) != null && s.quick_amounts.some((a) => a > max!)) issues.push("quick_amounts must not exceed max_amount");
  }
  if (s.dues_payment_methods && new Set(s.dues_payment_methods.map((m) => m.id)).size !== s.dues_payment_methods.length) {
    issues.push("dues_payment_methods ids must be unique");
  }
  return issues;
}

export const BlinkCashSettingsResponse = z
  .object({
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi("AdminBlinkCashSettings");

// ─── Offers ──────────────────────────────────────────────────────────

const i18nText = z.object({ en: z.string().trim().min(1).max(200), fr: z.string().trim().min(1).max(200), ar: z.string().trim().min(1).max(200) });
const i18nBody = z.object({ en: z.string().trim().max(1000), fr: z.string().trim().max(1000), ar: z.string().trim().max(1000) });

const OfferFields = z.object({
  title: i18nText,
  description: i18nBody.nullable(),
  min_deposit: dzd,
  bonus_type: z.enum(["fixed", "percent"]),
  bonus_value: z.number().positive().max(MAX_AMOUNT),
  max_bonus: dzd.nullable(),
  starts_at: z.string().datetime({ offset: true }).nullable(),
  ends_at: z.string().datetime({ offset: true }).nullable(),
  active: z.boolean(),
  per_user_limit: z.number().int().min(1).max(100),
  budget: dzd.nullable(),
});

export type OfferInput = z.infer<typeof OfferFields>;

export function offerRuleIssues(o: Partial<OfferInput>): string[] {
  const issues: string[] = [];
  if (o.bonus_type === "percent" && o.bonus_value != null && o.bonus_value > 100) issues.push("A percent bonus cannot exceed 100");
  if (o.starts_at && o.ends_at && Date.parse(o.ends_at) <= Date.parse(o.starts_at)) issues.push("ends_at must be after starts_at");
  return issues;
}

export const CreateOfferBody = OfferFields.partial({
  description: true,
  max_bonus: true,
  starts_at: true,
  ends_at: true,
  active: true,
  per_user_limit: true,
  budget: true,
}).openapi("CreateBlinkCashOffer");

export const UpdateOfferBody = OfferFields.partial()
  .refine((b) => Object.keys(b).length > 0, "Nothing to update")
  .openapi("UpdateBlinkCashOffer");

export const OfferResponse = z.object({ offer: z.record(z.string(), z.unknown()) }).openapi("AdminBlinkCashOffer");
export const OffersResponse = z
  .object({ offers: z.array(z.record(z.string(), z.unknown())), total: z.number() })
  .openapi("AdminBlinkCashOffers");

export const OffersQuery = z.object({
  active: z.enum(["true", "false"]).optional().openapi({ param: { name: "active", in: "query" } }),
  page: page("page"),
});

export const OfferIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

// ─── Wallets ─────────────────────────────────────────────────────────

export const WalletsQuery = z.object({
  q: z.string().trim().max(80).optional().openapi({ param: { name: "q", in: "query" } }),
  status: z.enum(["active", "frozen"]).optional().openapi({ param: { name: "status", in: "query" } }),
  page: page("page"),
});

export const WalletEntriesQuery = z.object({ page: page("page") });

export const UserIdParam = z.object({
  user_id: z.string().uuid().openapi({ param: { name: "user_id", in: "path" } }),
});

const WalletSummary = z.object({
  user_id: z.string(),
  name: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  balance: z.number(),
  held: z.number(),
  available: z.number(),
  status: z.enum(["active", "frozen"]),
  frozen_reason: z.string().nullable(),
  frozen_at: z.string().nullable(),
  backfilled_at: z.string().nullable(),
  last_activity_at: z.string().nullable(),
});

export const AdminWalletsResponse = z
  .object({ wallets: z.array(WalletSummary), total: z.number(), page: z.number(), page_size: z.number() })
  .openapi("AdminBlinkCashWallets");

export const AdminWalletDetailResponse = z
  .object({
    wallet: WalletSummary,
    entries: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    page: z.number(),
    page_size: z.number(),
  })
  .openapi("AdminBlinkCashWallet");

export const AdjustWalletBody = z
  .object({
    amount: money.refine((n) => n !== 0, "Amount must not be 0").refine((n) => Math.abs(n) <= MAX_AMOUNT, "Amount too large"),
    reason,
  })
  .openapi("AdjustBlinkCashWallet");

export const AdjustWalletResponse = z
  .object({ ok: z.literal(true), balance: z.number(), entry_id: z.string().nullable() })
  .openapi("AdjustBlinkCashWalletResponse");

export const ReasonBody = z.object({ reason }).openapi("BlinkCashReason");
export const FreezeResponse = z.object({ ok: z.literal(true), status: z.enum(["active", "frozen"]) }).openapi("BlinkCashFreezeResponse");

// ─── Transactions ────────────────────────────────────────────────────

export const TransactionIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

export const ApproveTransactionBody = z
  .object({ reference: z.string().trim().min(1).max(120) })
  .openapi("ApproveBlinkCashTransaction");

export const StaffTransactionResponse = z
  .object({ transaction: z.record(z.string(), z.unknown()) })
  .openapi("AdminBlinkCashTransaction");

// ─── Ledger ──────────────────────────────────────────────────────────

export const BackfillResponse = z
  .object({
    riders: z.number(),
    backfilled: z.number(),
    already_backfilled: z.number(),
    zero_opening: z.number(),
    failed: z.array(z.object({ user_id: z.string(), error: z.string() })),
  })
  .openapi("AdminBlinkCashBackfill");

export const ReconciliationResponse = z
  .object({
    generated_at: z.string(),
    totals: z.object({ circulation: z.number(), held: z.number(), wallets: z.number(), drift_count: z.number() }),
    mismatches: z.array(z.object({ user_id: z.string(), ledger: z.number(), expected: z.number(), diff: z.number() })),
  })
  .openapi("AdminBlinkCashReconciliation");

// ─── Dues payments (agents + merchants) ──────────────────────────────

export const RecordDuesPaymentBody = z
  .object({
    amount: z.number().positive().max(MAX_AMOUNT),
    method: z.string().trim().min(1).max(40),
    reference: z.string().trim().max(120).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .openapi("RecordDuesPayment");

export const DuesPaymentIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

export const DuesPaymentResponse = z.object({ payment: z.record(z.string(), z.unknown()) }).openapi("AdminDuesPayment");

export const AgentCreditLimitBody = z
  .object({ credit_limit: dzd.nullable() })
  .openapi("SetAgentCreditLimit");
export const AgentCreditLimitResponse = z
  .object({ agent_id: z.string(), credit_limit: z.number().nullable() })
  .openapi("AgentCreditLimit");
