import { z } from "@hono/zod-openapi";

// App-facing Blink Cash reads: settings (any signed-in role) and deposit
// offers (rider). The staff API lives in validators/blink-cash.ts.

export const electronicAccountSchema = z
  .object({
    label: z.string(),
    type: z.enum(["ccp", "baridimob", "rip", "bank"]),
    number: z.string(),
    holder: z.string(),
  })
  .openapi("BlinkCashElectronicAccount");

export const BlinkCashSettingsResponse = z
  .object({
    settings: z
      .object({
        deposit_fee_rate: z.number().openapi({ description: "0.02 = 2 %" }),
        withdrawal_fee_rate: z.number(),
        min_amount: z.number(),
        max_amount: z.number(),
        quick_amounts: z.array(z.number()),
        pending_expiry_minutes: z.number(),
        electronic_enabled: z.boolean(),
        /** Blink's receiving accounts for electronic deposits (shown only when electronic_enabled). */
        electronic_accounts: z.array(electronicAccountSchema),
        require_pin_for_withdrawal: z.boolean(),
        dues_payment_methods: z.array(z.object({ id: z.string(), label: z.string() })),
      })
      .openapi("BlinkCashSettings"),
  })
  .openapi("BlinkCashSettingsResponse");

const localized = z.object({ en: z.string(), fr: z.string(), ar: z.string() });

export const DepositOfferSchema = z
  .object({
    id: z.string(),
    /** SF Symbol name for the carousel card. */
    icon: z.string(),
    title: localized,
    subtitle: localized,
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    /** active = running now, upcoming = starts later. */
    status: z.enum(["active", "upcoming"]),
    min_deposit: z.number(),
    bonus_type: z.enum(["fixed", "percent"]),
    /** DA for fixed, a percentage (10 = 10 %) for percent. */
    bonus_value: z.number(),
    max_bonus: z.number().nullable(),
  })
  .openapi("DepositOffer");

export const DepositOfferListResponse = z
  .object({ offers: z.array(DepositOfferSchema) })
  .openapi("DepositOfferListResponse");
