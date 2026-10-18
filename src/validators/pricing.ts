import { z } from "@hono/zod-openapi";
import { PRICING_KEYS } from "../lib/pricing/catalog";

// ─── Staff (tag admin-pricing) ───────────────────────────────────────

export const FeeExampleSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("per_checkout"), output: z.number() }),
    z.object({ kind: z.literal("trip_km"), vehicle: z.enum(["motorcycle", "bicycle"]), km: z.number(), output: z.number() }),
    z.object({ kind: z.literal("multiplier"), km: z.number(), input: z.number(), output: z.number() }),
    z.object({ kind: z.literal("rate_on_amount"), input: z.number(), output: z.number() }),
    z.object({ kind: z.literal("agent_split"), input: z.number(), output: z.number() }),
    z.object({ kind: z.literal("amount"), output: z.number() }),
  ])
  .openapi("FeeExample");

export const PricingKeyParam = z.object({
  key: z.string().openapi({ param: { name: "key", in: "path" } }),
});
export const PricingOverrideIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

const group = z.enum(["customer", "partner", "tax"]);
const status = z.enum(["active", "scheduled", "ended", "archived"]);
const iso = z.string().datetime({ offset: true });
const scopeFields = {
  service: z.string().nullable(),
  wilaya_code: z.string().nullable(),
  merchant_id: z.string().uuid().nullable(),
  agent_id: z.string().uuid().nullable(),
};

export const PricingFee = z
  .object({
    key: z.enum(PRICING_KEYS),
    group,
    unit: z.enum(["da", "percent", "multiplier", "fare"]).openapi({ description: "How the dashboard renders/edits the value" }),
    scopes: z.object({
      service: z.array(z.string()).nullable(),
      wilaya: z.boolean(),
      merchant: z.boolean(),
      agent: z.boolean(),
    }),
    fields: z
      .array(
        z.object({
          path: z.string().openapi({ description: 'Dot path into the value, e.g. "amount", "bicycle.base"' }),
          unit: z.enum(["da", "rate", "km", "multiplier"]),
          min: z.number(),
          max: z.number(),
          step: z.number(),
        })
      )
      .openapi({ description: "Editable fields with bounds + step, derived from the same constants as the value schema" }),
    value: z.unknown(),
    seed: z.unknown(),
    updated_at: z.string().nullable(),
    updated_by: z.string().nullable(),
    active_overrides: z.number().int(),
    example: FeeExampleSchema.nullable().openapi({ description: "Worked example from the default value" }),
  })
  .openapi("PricingFee");

export const PricingCatalogResponse = z.object({ fees: z.array(PricingFee) }).openapi("PricingCatalogResponse");
export const PricingFeeResponse = z.object({ fee: PricingFee }).openapi("PricingFeeResponse");

export const UpdatePricingDefaultBody = z
  .object({
    value: z.unknown(),
    expected_updated_at: z.string().optional().openapi({ description: "409 stale when the stored updated_at differs" }),
  })
  .openapi("UpdatePricingDefaultBody");

export const PricingOverride = z
  .object({
    id: z.string().uuid(),
    key: z.enum(PRICING_KEYS),
    ...scopeFields,
    value: z.unknown(),
    starts_at: z.string().nullable(),
    ends_at: z.string().nullable(),
    note: z.string().nullable(),
    status,
    partner_name: z.string().nullable(),
    created_by: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PricingOverride");

export const ListPricingOverridesQuery = z.object({
  key: z.string().optional(),
  status: status.optional(),
  wilaya_code: z.string().optional(),
  merchant_id: z.string().uuid().optional(),
  agent_id: z.string().uuid().optional(),
});
export const PricingOverridesResponse = z.object({ overrides: z.array(PricingOverride) }).openapi("PricingOverridesResponse");
export const PricingOverrideResponse = z.object({ override: PricingOverride }).openapi("PricingOverrideResponse");

export const CreatePricingOverrideBody = z
  .object({
    key: z.string(),
    service: z.string().nullish(),
    wilaya_code: z.string().nullish(),
    merchant_id: z.string().uuid().nullish(),
    agent_id: z.string().uuid().nullish(),
    value: z.unknown(),
    starts_at: iso.nullish(),
    ends_at: iso.nullish(),
    note: z.string().max(500).nullish(),
  })
  .openapi("CreatePricingOverrideBody");

export const UpdatePricingOverrideBody = z
  .object({
    value: z.unknown().optional(),
    starts_at: iso.nullish(),
    ends_at: iso.nullish(),
    note: z.string().max(500).nullish(),
  })
  .openapi("UpdatePricingOverrideBody");

export const PricingOverlapError = z
  .object({ error: z.literal("overlap"), conflict_id: z.string().uuid() })
  .openapi("PricingOverlapError");
export const PricingStaleError = z.object({ error: z.literal("stale"), updated_at: z.string().nullable() }).openapi("PricingStaleError");

export const PricingChange = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    override_id: z.string().nullable(),
    action: z.enum(["update_default", "create_override", "update_override", "archive_override"]),
    before: z.unknown(),
    after: z.unknown(),
    actor_id: z.string().nullable(),
    actor_name: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("PricingChange");
export const PricingHistoryQuery = z.object({
  key: z.string().optional(),
  override_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const PricingHistoryResponse = z.object({ changes: z.array(PricingChange) }).openapi("PricingHistoryResponse");

export const PricingPreviewBody = z
  .object({
    context: z.object({
      service: z.string().optional(),
      wilaya_code: z.string().nullish(),
      merchant_id: z.string().uuid().nullish(),
      agent_id: z.string().uuid().nullish(),
      at: iso.optional(),
    }),
    sample: z
      .object({
        km: z.number().positive().max(500).optional(),
        stops: z.number().int().min(1).max(10).optional(),
        amount: z.number().positive().optional(),
      })
      .optional(),
    candidate: z
      .object({ key: z.enum(PRICING_KEYS), value: z.unknown() })
      .optional()
      .openapi({ description: "An unsaved value for one fee; examples are also computed with it replacing that key's effective value (candidate_examples)" }),
  })
  .openapi("PricingPreviewBody");

const PricingExamples = z.object({
  courier_fare: z.object({ bicycle: z.number(), motorcycle: z.number() }).optional(),
  ride_fare: z.object({ motorcycle: z.number() }).optional(),
  blink_cash_fee: z.object({ type: z.enum(["deposit", "withdrawal"]), amount: z.number(), fees: z.number() }).optional(),
});

export const PricingPreviewResponse = z
  .object({
    values: z.array(
      z.object({
        key: z.enum(PRICING_KEYS),
        value: z.unknown(),
        override_id: z.string().nullable(),
        scope: z.object(scopeFields).nullable(),
      })
    ),
    examples: PricingExamples,
    candidate_examples: PricingExamples.optional(),
    candidate_example: z
      .object({ key: z.enum(PRICING_KEYS), before: FeeExampleSchema.nullable(), after: FeeExampleSchema.nullable() })
      .optional(),
  })
  .openapi("PricingPreviewResponse");

export const PricingSimulateBody = z
  .object({
    scenario: z.enum(["store", "courier", "ride", "deposit", "withdrawal"]),
    context: z
      .object({
        wilaya_code: z.string().nullish(),
        merchant_id: z.string().uuid().nullish(),
        agent_id: z.string().uuid().nullish(),
        store_id: z.string().uuid().nullish(),
        at: iso.optional(),
      })
      .optional(),
    inputs: z
      .object({
        subtotal: z.number().nonnegative().optional(),
        delivery_fee: z.number().nonnegative().optional(),
        km: z.number().positive().max(500).optional(),
        stops: z.number().int().min(1).max(10).optional(),
        vehicle: z.enum(["bicycle", "motorcycle"]).optional(),
        amount: z.number().positive().optional(),
      })
      .optional(),
  })
  .openapi("PricingSimulateBody");

export const PricingSimulateResponse = z
  .object({
    scenario: z.enum(["store", "courier", "ride", "deposit", "withdrawal"]),
    payer_total: z.number(),
    lines: z.array(
      z.object({
        party: z.enum(["merchant", "rider", "agent", "blink", "tax"]),
        label: z.enum([
          "merchant_keeps", "rider_keeps", "agent_keeps", "service_fee", "merchant_commission",
          "rider_commission", "platform_share", "stamp_duty", "agent_tax",
        ]),
        amount: z.number(),
      })
    ),
    values: z.array(
      z.object({
        key: z.enum(PRICING_KEYS),
        value: z.unknown(),
        override_id: z.string().nullable(),
        scope: z.object(scopeFields).nullable(),
      })
    ),
    unavailable: z.enum(["too_far"]).nullable(),
  })
  .openapi("PricingSimulateResponse");

// ─── App quotes (generated client) ───────────────────────────────────

export const QuoteOrderBody = z
  .object({
    type: z.enum(["merchant", "shopper"]),
    store_id: z.string().uuid().optional(),
    /** Delivery destination — the wilaya fallback when the store has none. */
    lat: z.number().optional(),
    lng: z.number().optional(),
    checkout_id: z.string().uuid().optional(),
  })
  .openapi("QuoteOrderBody");

export const QuoteOrderResponse = z
  .object({
    service_fee: z.number().openapi({ description: "DZD; 0 when this checkout already paid it" }),
  })
  .openapi("QuoteOrderResponse");

export const QuoteTransactionBody = z
  .object({
    type: z.enum(["deposit", "withdrawal"]),
    amount: z.number().positive("Amount must be positive"),
  })
  .openapi("QuoteTransactionBody");

export const QuoteTransactionResponse = z
  .object({
    fees: z.number(),
    total: z.number().openapi({ description: "Deposit: amount + fees. Withdrawal: amount − fees." }),
    fee_rate: z.number(),
  })
  .openapi("QuoteTransactionResponse");
