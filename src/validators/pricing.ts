import { z } from "@hono/zod-openapi";
import { CLASS_CODE_RE, PRICING_KEYS, TIER_CODE_RE } from "../lib/pricing/catalog";

// ─── Staff (tag admin-pricing) ───────────────────────────────────────

export const FeeExampleSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("per_checkout"), output: z.number() }),
    z.object({ kind: z.literal("trip_km"), vehicle: z.string(), km: z.number(), output: z.number() }),
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

const group = z.enum(["customer", "partner", "tax", "formula", "zones"]);
const status = z.enum(["active", "scheduled", "ended", "archived"]);
const iso = z.string().datetime({ offset: true });
const scopeFields = {
  service: z.string().nullable(),
  wilaya_code: z.string().nullable(),
  merchant_id: z.string().uuid().nullable(),
  agent_id: z.string().uuid().nullable(),
  zone_id: z.string().uuid().nullable(),
  tier: z.string().nullable(),
};

export const PricingFee = z
  .object({
    key: z.enum(PRICING_KEYS),
    group,
    unit: z
      .enum(["da", "percent", "multiplier", "fare", "formula", "surcharge", "toggle", "tier", "delivery"])
      .openapi({ description: "How the dashboard renders/edits the value" }),
    scopes: z.object({
      service: z.array(z.string()).nullable(),
      wilaya: z.boolean(),
      merchant: z.boolean(),
      agent: z.boolean(),
      zone: z.boolean(),
      tier: z.boolean(),
    }),
    fields: z
      .array(
        z.object({
          path: z.string().openapi({ description: 'Dot path into the value, e.g. "amount", "bicycle.base"' }),
          class: z.string().optional().openapi({ description: "Leg fields: the vehicle class code the field belongs to" }),
          unit: z.enum(["da", "rate", "km", "multiplier", "kmh", "min", "bool", "choice", "tier"]),
          min: z.number(),
          max: z.number(),
          step: z.number(),
          options: z
            .array(z.string())
            .optional()
            .openapi({ description: "choice: the allowed values; tier: the live tier codes" }),
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

export const VehicleClassView = z
  .object({
    code: z.string(),
    names: z.object({ en: z.string(), fr: z.string(), ar: z.string() }),
    base_vehicle: z.enum(["bicycle", "motorcycle"]),
    services: z.array(z.enum(["ride", "courier", "store"])),
    exclusive: z.boolean(),
    enabled: z.boolean(),
    sort_order: z.number().int(),
    note: z.string().nullable(),
    archived_at: z.string().nullable(),
    rider_count: z.number().int().openapi({ description: "Riders assigned to this class" }),
    updated_at: z.string(),
  })
  .openapi("VehicleClass");

export const PricingCatalogResponse = z
  .object({
    fees: z.array(PricingFee),
    vehicle_classes: z
      .array(VehicleClassView)
      .openapi({ description: "Live (non-archived) vehicle classes, in display order; leg fields carry `class`" }),
  })
  .openapi("PricingCatalogResponse");
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
    zone_name: z.string().nullable(),
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
  zone_id: z.string().uuid().optional(),
  tier: z.string().optional(),
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
    zone_id: z.string().uuid().nullish(),
    tier: z.string().nullish(),
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
    zone_id: z.string().nullable(),
    tier: z.string().nullable(),
    action: z.enum([
      "update_default",
      "create_override",
      "update_override",
      "archive_override",
      "create_zone",
      "update_zone",
      "archive_zone",
      "create_tier",
      "update_tier",
      "archive_tier",
      "create_vehicle_class",
      "update_vehicle_class",
      "archive_vehicle_class",
    ]),
    vehicle_class: z.string().nullable(),
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
  zone_id: z.string().uuid().optional(),
  tier: z.string().optional(),
  vehicle_class: z.string().optional(),
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
      zone_id: z.string().uuid().nullish(),
      tier: z.string().nullish(),
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
  courier_fare: z.record(z.string(), z.number()).optional().openapi({ description: "5 km fare per enabled courier class code" }),
  ride_fare: z.record(z.string(), z.number()).optional().openapi({ description: "5 km fare per enabled ride class code" }),
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

const LatLngBody = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const PricingPlaceView = z
  .object({
    wilaya_code: z.string().nullable(),
    zone: z.object({ id: z.string().uuid(), name: z.string(), tier: z.string() }).nullable(),
    tier: z.string().nullable().openapi({ description: "null when the unzoned tier is archived/missing" }),
    unzoned: z.boolean().openapi({ description: "true when no zone contains the point (tier = the wilaya's unzoned tier)" }),
  })
  .openapi("PricingPlace");

export const PricingSimulateBody = z
  .object({
    scenario: z.enum(["store", "courier", "ride", "deposit", "withdrawal"]),
    context: z
      .object({
        wilaya_code: z.string().nullish(),
        merchant_id: z.string().uuid().nullish(),
        agent_id: z.string().uuid().nullish(),
        store_id: z.string().uuid().nullish(),
        zone_id: z.string().uuid().nullish().openapi({ description: "Price as inside this zone (its tier and wilaya apply)" }),
        tier: z.string().nullish().openapi({ description: "Price as in this tier (with wilaya_code when given)" }),
        pickup: LatLngBody.optional().openapi({
          description: "Courier/ride: derives the pickup place; with `dropoff` also km, surcharge and service area",
        }),
        dropoff: LatLngBody.optional(),
        at: iso.optional(),
      })
      .optional(),
    inputs: z
      .object({
        subtotal: z.number().nonnegative().optional(),
        delivery_fee: z.number().nonnegative().optional(),
        km: z.number().positive().max(500).optional(),
        stops: z.number().int().min(1).max(10).optional(),
        vehicle: z.string().regex(CLASS_CODE_RE).optional().openapi({ description: "Any vehicle class code (default motorcycle)" }),
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
    unavailable: z.enum(["too_far", "too_close", "out_of_service_area"]).nullable(),
    breakdown: z
      .array(
        z.object({
          step: z.enum(["base", "distance", "time", "extra_stops", "dropoff_surcharge", "multiplier", "clamp", "rounding"]),
          amount: z.number(),
        })
      )
      .optional()
      .openapi({ description: "Courier/ride only: each step's contribution to the fare; they sum to payer_total" }),
    place: PricingPlaceView.nullable().openapi({ description: "The pricing place used (null when none was determined)" }),
    delivery_mode: z
      .enum(["merchant", "distance"])
      .optional()
      .openapi({ description: "Store scenario with a store/pickup + drop-off: how the delivery fee was priced" }),
    vehicle: z.string().nullable().optional().openapi({ description: "Store scenario, distance mode: the class that priced it" }),
  })
  .openapi("PricingSimulateResponse");

// ─── Zones + tiers (tag admin-pricing) ───────────────────────────────

const Geometry = z
  .object({ type: z.enum(["Polygon", "MultiPolygon"]), coordinates: z.array(z.any()) })
  .openapi("ZoneGeometry", { description: "GeoJSON Polygon | MultiPolygon, [lng, lat]; open rings are closed by the server" });
const TierCode = z.string().regex(TIER_CODE_RE, "Lower-case letters, digits and _ (2–24 chars, starts with a letter)");
const TierNames = z.object({ en: z.string().min(1).max(60), fr: z.string().min(1).max(60), ar: z.string().min(1).max(60) });
const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use #RRGGBB");

export const PricingZone = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    tier: z.string(),
    wilaya_code: z.string().nullable(),
    geometry: Geometry,
    priority: z.number().int(),
    note: z.string().nullable(),
    area_km2: z.number(),
    override_count: z.number().int().openapi({ description: "Live (non-archived) overrides scoped to this zone" }),
    archived_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("PricingZone");

export const PricingTier = z
  .object({
    code: z.string(),
    names: TierNames,
    color: z.string(),
    sort_order: z.number().int(),
    note: z.string().nullable(),
    archived_at: z.string().nullable(),
    zone_count: z.number().int().openapi({ description: "Live zones using this tier" }),
    override_count: z.number().int().openapi({ description: "Live overrides scoped to this tier" }),
    updated_at: z.string(),
  })
  .openapi("PricingTier");

export const ListPricingZonesQuery = z.object({
  include_archived: z
    .enum(["true", "false"])
    .optional()
    .openapi({ description: "Also return archived zones and tiers (default false)" }),
});
export const PricingZonesResponse = z
  .object({
    zones: z.array(PricingZone),
    tiers: z.array(PricingTier),
    unzoned_tier: z.string().nullable().openapi({ description: "The default `zone_defaults.unzoned_tier`" }),
  })
  .openapi("PricingZonesResponse");
export const PricingZoneResponse = z.object({ zone: PricingZone }).openapi("PricingZoneResponse");
export const PricingZoneIdParam = z.object({ id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }) });

export const CreatePricingZoneBody = z
  .object({
    name: z.string().trim().min(1).max(80),
    tier: TierCode,
    geometry: z.unknown(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    note: z.string().max(500).nullish(),
    wilaya_code: z.string().nullish().openapi({ description: "Derived from the geometry when omitted" }),
  })
  .openapi("CreatePricingZoneBody");

export const UpdatePricingZoneBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    tier: TierCode.optional(),
    geometry: z.unknown().optional(),
    priority: z.number().int().min(-1000).max(1000).optional(),
    note: z.string().max(500).nullish(),
    wilaya_code: z.string().nullish(),
    expected_updated_at: z.string().optional().openapi({ description: "409 stale when the stored updated_at differs" }),
  })
  .openapi("UpdatePricingZoneBody");

export const ImportPricingZonesBody = z
  .object({
    geojson: z.unknown().openapi({ description: "A GeoJSON FeatureCollection of Polygon/MultiPolygon features (≤ 200)" }),
    tier: TierCode,
    name_property: z.string().default("name"),
  })
  .openapi("ImportPricingZonesBody");
export const PricingZonesImportResponse = z.object({ zones: z.array(PricingZone) }).openapi("PricingZonesImportResponse");

export const PricingZoneInUseError = z
  .object({ error: z.string(), code: z.literal("zone_in_use"), override_count: z.number().int() })
  .openapi("PricingZoneInUseError");
export const PricingTierInUseError = z
  .object({
    error: z.string(),
    code: z.literal("tier_in_use"),
    zone_count: z.number().int(),
    override_count: z.number().int(),
    default_in_use: z.boolean().openapi({ description: "true when a zone_defaults value (default or override) names this tier" }),
  })
  .openapi("PricingTierInUseError");

export const PricingTierCodeParam = z.object({ code: z.string().openapi({ param: { name: "code", in: "path" } }) });
export const PricingTierResponse = z.object({ tier: PricingTier }).openapi("PricingTierResponse");
export const CreatePricingTierBody = z
  .object({
    code: TierCode,
    names: TierNames,
    color: Color,
    sort_order: z.number().int().min(0).max(1000).optional(),
    note: z.string().max(500).nullish(),
  })
  .openapi("CreatePricingTierBody");
export const UpdatePricingTierBody = z
  .object({
    names: TierNames.optional(),
    color: Color.optional(),
    sort_order: z.number().int().min(0).max(1000).optional(),
    note: z.string().max(500).nullish(),
  })
  .openapi("UpdatePricingTierBody");

export const PricingLookupQuery = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});
export const PricingLookupResponse = z
  .object({
    place: PricingPlaceView,
    values: z.array(
      z.object({
        key: z.enum(PRICING_KEYS),
        service: z.string().nullable(),
        value: z.unknown(),
        override_id: z.string().nullable(),
      })
    ),
    samples: z.array(
      z.object({
        scenario: z.enum(["ride", "courier", "store"]),
        vehicle: z.string().openapi({ description: "A vehicle class code" }),
        km: z.number(),
        fare: z.number().nullable().openapi({ description: "null only for the store sample in merchant mode" }),
        available: z.boolean(),
        unavailable: z.enum(["too_far", "out_of_service_area"]).nullable(),
        mode: z.enum(["merchant", "distance"]).optional().openapi({ description: "Store sample only" }),
      })
    ),
  })
  .openapi("PricingLookupResponse");

// ─── Vehicle classes + rider class (tag admin-pricing) ───────────────

const ClassServices = z.array(z.enum(["ride", "courier", "store"])).min(1).max(3);
const ClassNames = z.object({ en: z.string().min(1).max(60), fr: z.string().min(1).max(60), ar: z.string().min(1).max(60) });
export const VehicleClassCodeParam = z.object({ code: z.string().openapi({ param: { name: "code", in: "path" } }) });
export const VehicleClassesResponse = z
  .object({ vehicle_classes: z.array(VehicleClassView) })
  .openapi("VehicleClassesResponse");
export const VehicleClassResponse = z.object({ vehicle_class: VehicleClassView }).openapi("VehicleClassResponse");
export const ListVehicleClassesQuery = z.object({
  include_archived: z.enum(["true", "false"]).optional().openapi({ description: "Also return archived classes (default false)" }),
});
export const CreateVehicleClassBody = z
  .object({
    code: z.string().regex(CLASS_CODE_RE, "Lower-case letters, digits and _ (2–24 chars, starts with a letter)"),
    names: ClassNames,
    base_vehicle: z.enum(["bicycle", "motorcycle"]),
    services: ClassServices,
    exclusive: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(1000).optional(),
    note: z.string().max(500).nullish(),
  })
  .openapi("CreateVehicleClassBody");
export const UpdateVehicleClassBody = z
  .object({
    names: ClassNames.optional(),
    base_vehicle: z.enum(["bicycle", "motorcycle"]).optional(),
    services: ClassServices.optional(),
    exclusive: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sort_order: z.number().int().min(0).max(1000).optional(),
    note: z.string().max(500).nullish(),
    expected_updated_at: z.string().optional().openapi({ description: "409 stale when the stored updated_at differs" }),
  })
  .openapi("UpdateVehicleClassBody");
export const VehicleClassInUseError = z
  .object({
    error: z.string(),
    code: z.literal("class_in_use"),
    rider_count: z.number().int(),
    override_count: z.number().int().openapi({ description: "Live overrides / defaults holding a leg for this class on a service it serves" }),
    open_orders: z.number().int(),
  })
  .openapi("VehicleClassInUseError");
export const RiderUserIdParam = z.object({ user_id: z.string().uuid().openapi({ param: { name: "user_id", in: "path" } }) });
export const RiderVehicleClassView = z
  .object({ user_id: z.string().uuid(), vehicle_type: z.string().nullable(), vehicle_class: z.string().nullable() })
  .openapi("RiderVehicleClass");
export const SetRiderVehicleClassBody = z
  .object({ vehicle_class: z.string().regex(CLASS_CODE_RE).nullable() })
  .openapi("SetRiderVehicleClassBody");

// ─── App quotes (generated client) ───────────────────────────────────

export const QuoteOrderBody = z
  .object({
    type: z.enum(["merchant", "shopper"]),
    store_id: z.string().uuid().optional(),
    /** Delivery destination — the wilaya fallback when the store has none. */
    lat: z.number().optional(),
    lng: z.number().optional(),
    checkout_id: z.string().uuid().optional(),
    store_ids: z
      .array(z.string().uuid())
      .max(10)
      .optional()
      .openapi({ description: "Stores to quote the delivery fee for (one entry each in `delivery_fees`); `lat` / `lng` is the customer point" }),
  })
  .openapi("QuoteOrderBody");

export const StoreDeliveryFeeSchema = z
  .object({
    store_id: z.string().uuid(),
    delivery_fee: z.number().openapi({ description: "DZD, before any free-pack waiver; send it back as `expected_delivery_fee`" }),
    mode: z.enum(["merchant", "distance"]).openapi({ description: "How it was priced (distance falls back to merchant without a customer point)" }),
  })
  .openapi("StoreDeliveryFee");

export const QuoteOrderResponse = z
  .object({
    service_fee: z.number().openapi({ description: "DZD; 0 when this checkout already paid it" }),
    delivery_fees: z
      .array(StoreDeliveryFeeSchema)
      .optional()
      .openapi({ description: "Present when `store_ids` was sent; unknown / inactive stores are left out" }),
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
