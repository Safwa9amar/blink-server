// Validation + response schemas for the merchant app endpoints (/merchant/*).
import { z } from "@hono/zod-openapi";
import { merchantDuesPayments, storePacks } from "../db/schema";
import { rowSchema } from "../openapi";
import { StoreProductSchema, StoreSchema } from "./marketplace";
import { OrderSchema } from "./orders";

// ─── Shared shapes ───────────────────────────────────────────────────

export const shiftSchema = z
  .object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/) })
  .openapi("StoreShift");

export const weekHoursSchema = z
  .record(z.string(), z.object({ enabled: z.boolean(), shifts: z.array(shiftSchema) }))
  .openapi("StoreWeekHours");

export const documentsSchema = z
  .object({
    commercial_register_front_url: z.string().nullable().optional(),
    commercial_register_back_url: z.string().nullable().optional(),
    nif: z.string().optional(),
    nis: z.string().optional(),
    additional_docs: z
      .array(z.object({ id: z.string(), name: z.string(), url: z.string() }))
      .optional(),
  })
  .openapi("StoreDocuments");

const packItemSchema = z
  .object({
    product_id: z.string(),
    quantity: z.number().int().positive(),
    qty_promo_enabled: z.boolean(),
    buy_qty: z.number().int().nonnegative(),
    get_qty: z.number().int().nonnegative(),
  })
  .openapi("PackItem");

export const PERIODS = ["today", "this_week", "this_month", "this_year", "custom"] as const;
const periodSchema = z.enum(PERIODS);

// ─── Stores ──────────────────────────────────────────────────────────

const storeFields = {
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  whatsapp: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  image: z.string().optional(),
  logo: z.string().nullable().optional(),
  gallery: z.array(z.string()).max(10).optional(),
  location: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  wilaya: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  category_slugs: z.array(z.string()).optional(),
  hours: weekHoursSchema.nullable().optional(),
  documents: documentsSchema.optional(),
};

export const createMerchantStoreSchema = z.object(storeFields).openapi("CreateMerchantStoreBody");

export const updateMerchantStoreSchema = z
  .object({
    ...storeFields,
    weekly_goal: z.number().nonnegative().optional(),
    name: storeFields.name.optional(),
    is_open: z.boolean().optional(),
    manual_override: z.boolean().optional(),
    is_primary: z.boolean().optional(),
    delivery_fee: z.number().nonnegative().optional(),
    min_order: z.number().nonnegative().optional(),
    delivery_time: z.string().nullable().optional(),
  })
  .openapi("UpdateMerchantStoreBody");

export const MerchantStoreSchema = StoreSchema.extend({
  hours: weekHoursSchema.nullable(),
  documents: documentsSchema,
  total_sales: z.number(),
  orders_count: z.number().int(),
}).openapi("MerchantStore");

export const MerchantStoreListResponse = z
  .object({ stores: z.array(MerchantStoreSchema) })
  .openapi("MerchantStoreListResponse");
export const MerchantStoreResponse = z
  .object({ store: MerchantStoreSchema })
  .openapi("MerchantStoreResponse");

// ─── Products ────────────────────────────────────────────────────────

const productFields = {
  title: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  barcode: z.string().optional(),
  brand: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().nullable().optional(),
  photos: z.array(z.string()).max(5).optional(),
  stock: z.number().int().nonnegative().optional(),
  price: z.number().nonnegative().optional(),
  is_available: z.boolean().optional(),
};

export const createMerchantProductSchema = z
  .object({
    ...productFields,
    title: productFields.title.optional(),
    /** Add from the Blink Library — copies its name/brand/barcode/photos. */
    library_product_id: z.string().uuid().optional(),
  })
  .refine((b) => b.library_product_id || b.title, {
    message: "title is required for manual products",
    path: ["title"],
  })
  .openapi("CreateMerchantProductBody");

export const updateMerchantProductSchema = z
  .object({
    ...productFields,
    title: productFields.title.optional(),
    /** Propose a new selling price; auto-accepted within ±20% of blink_price. */
    suggested_price: z.number().positive().optional(),
  })
  .openapi("UpdateMerchantProductBody");

export const MerchantProductSchema = StoreProductSchema.extend({
  photos: z.array(z.string()),
}).openapi("MerchantProduct");

export const MerchantProductListResponse = z
  .object({ products: z.array(MerchantProductSchema) })
  .openapi("MerchantProductListResponse");
export const MerchantProductResponse = z
  .object({ product: MerchantProductSchema })
  .openapi("MerchantProductResponse");

// ─── Blink Library ───────────────────────────────────────────────────

export const listLibrarySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional().openapi({ description: "Category name_en" }),
});

export const LibraryProductSchema = z
  .object({
    id: z.string(),
    name_en: z.string(),
    name_fr: z.string(),
    name_ar: z.string(),
    description_en: z.string(),
    description_fr: z.string(),
    description_ar: z.string(),
    barcode: z.string(),
    brand: z.string(),
    category: z.string(),
    unit: z.string(),
    photos: z.array(z.string()),
  })
  .openapi("LibraryProduct");

export const LibraryListResponse = z
  .object({ products: z.array(LibraryProductSchema), categories: z.array(z.string()) })
  .openapi("LibraryListResponse");

// ─── Packs ───────────────────────────────────────────────────────────

const packFields = {
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  image: z.string().nullable().optional(),
  items: z.array(packItemSchema).min(1),
  discount_enabled: z.boolean().optional(),
  discount_percent: z.number().int().min(0).max(90).optional(),
  free_delivery: z.boolean().optional(),
};

export const createPackSchema = z.object(packFields).openapi("CreatePackBody");
export const updatePackSchema = z
  .object({
    ...packFields,
    name: packFields.name.optional(),
    items: packFields.items.optional(),
    status: z.enum(["active", "inactive", "archived"]).optional(),
  })
  .openapi("UpdatePackBody");

export const PackSchema = rowSchema(storePacks, "PackRow")
  .extend({ items: z.array(packItemSchema) })
  .openapi("Pack");
export const PackListResponse = z.object({ packs: z.array(PackSchema) }).openapi("PackListResponse");
export const PackResponse = z.object({ pack: PackSchema }).openapi("PackResponse");

// ─── Orders ──────────────────────────────────────────────────────────

export const listMerchantOrdersSchema = z.object({
  store_id: z.string().uuid().optional(),
  scope: z
    .enum(["active", "history", "all"])
    .optional()
    .openapi({ description: "active = needs merchant attention / in progress" }),
  /** History filters. */
  kind: z.enum(["simple", "packs"]).optional(),
  status: z.enum(["completed", "cancelled"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export const REJECT_REASONS = ["too_busy", "out_of_stock", "closing_soon", "cannot_fulfil"] as const;

export const merchantOrderActionSchema = z
  .object({
    action: z.enum(["accept", "reject", "ready", "picked_up", "delivered"]),
    /** Required with `reject`. `too_busy` hands the order to a Blink shopper. */
    reason: z.enum(REJECT_REASONS).optional(),
  })
  .refine((b) => b.action !== "reject" || !!b.reason, {
    message: "reason is required to reject",
    path: ["reason"],
  })
  .openapi("MerchantOrderActionBody");

const personSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    phone: z.string().nullable(),
    avatar: z.string().nullable(),
  })
  .openapi("OrderPerson");

/** Another part of the same checkout, in a store with the same owner. */
export const MerchantOrderSiblingSchema = OrderSchema.pick({
  id: true,
  store_id: true,
  store_name: true,
  status: true,
  merchant_status: true,
  type: true,
  subtotal: true,
  total: true,
  accepted_at: true,
  prepared_at: true,
  rider_assigned_at: true,
})
  .extend({ item_count: z.number().int() })
  .openapi("MerchantOrderSibling");

/** Order + who's involved, for the merchant's order cards. */
export const MerchantOrderSchema = OrderSchema.extend({
  customer_name: z.string().nullable(),
  customer_avatar: z.string().nullable(),
  rider_name: z.string().nullable(),
  driver_name: z.string().nullable(),
  /** The rider the store asked to deliver (POST /merchant/orders/{id}/assign). */
  offered_rider_name: z.string().nullable(),
  offer_status: z.enum(["pending", "declined", "expired"]).nullable().openapi({
    description:
      "The store's rider request while the order waits for a rider: pending (answer due by offer_expires_at), declined or expired; null when there is none",
  }),
  offer_expires_at: z
    .string()
    .nullable()
    .openapi({ description: "When the requested rider's time to answer runs out (ISO), while pending" }),
  has_pack: z.boolean(),
  own_siblings: z.array(MerchantOrderSiblingSchema).openapi({
    description:
      "The other parts of this order's checkout in stores with the same owner (one checkout across several of the merchant's stores); empty otherwise",
  }),
  checkout_own_only: z.boolean().openapi({
    description:
      "Every store in this order's checkout is the merchant's: one of its own drivers may collect the whole checkout",
  }),
}).openapi("MerchantOrder");

export const MerchantOrderListResponse = z
  .object({ orders: z.array(MerchantOrderSchema) })
  .openapi("MerchantOrderListResponse");
export const MerchantOrderResponse = z
  .object({ order: OrderSchema })
  .openapi("MerchantOrderResponse");
/** The order with names + rider request state: answer to assigning or withdrawing a request. */
export const EnrichedMerchantOrderResponse = z
  .object({ order: MerchantOrderSchema })
  .openapi("EnrichedMerchantOrderResponse");

export const MerchantOrderDetailResponse = z
  .object({
    order: MerchantOrderSchema,
    store: z.object({
      id: z.string(),
      name: z.string(),
      image: z.string(),
      address: z.string().nullable(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
    }),
    customer: personSchema.extend({ orders_count: z.number().int() }).nullable(),
    rider: personSchema
      .extend({ vehicle_type: z.string().nullable(), plate: z.string().nullable(), deliveries: z.number().int() })
      .nullable(),
    driver: personSchema
      .extend({ vehicle_type: z.string().nullable(), plate: z.string().nullable() })
      .nullable(),
    /** Customer/rider contact details are hidden 48h after the order closed. */
    contacts_hidden: z.boolean(),
    pack_names: z.array(z.string()),
    earnings: z.number(),
    timeline: z.array(
      z
        .object({
          key: z.enum(["placed", "accepted", "prepared", "rider_assigned", "picked_up", "delivered", "canceled"]),
          at: z.string().nullable(),
        })
        .openapi("OrderTimelineStep")
    ),
  })
  .openapi("MerchantOrderDetailResponse");

// ─── Rider assignment ────────────────────────────────────────────────

export const AssignableRiderSchema = z
  .object({
    id: z.string().openapi({ description: "store_driver id (own) or rider user id (blink)" }),
    kind: z.enum(["own_blink", "external", "blink"]),
    name: z.string(),
    phone: z.string().nullable(),
    avatar: z.string().nullable(),
    vehicle_type: z.string().nullable(),
    plate: z.string().nullable(),
    deliveries: z.number().int(),
    distance_km: z.number().nullable(),
    eta_min: z.number().int().nullable(),
    status: z.enum(["available", "busy", "offline"]),
    /** This order's request is waiting on them (live, or in the accept grace). */
    requested: z.boolean(),
    /** They turned this order down; the store may still ask them again. */
    declined: z.boolean(),
  })
  .openapi("AssignableRider");

export const OrderRidersResponse = z
  .object({
    own: z.array(AssignableRiderSchema),
    blink: z.array(AssignableRiderSchema),
    suggested: AssignableRiderSchema.nullable(),
  })
  .openapi("OrderRidersResponse");

export const assignRiderSchema = z
  .object({
    mode: z.enum(["own", "blink"]),
    /** store_driver id for `own`; rider user id for `blink` (omit = auto-match nearest). */
    rider_id: z.string().uuid().optional(),
  })
  .refine((b) => b.mode === "blink" || !!b.rider_id, {
    message: "rider_id is required for own riders",
    path: ["rider_id"],
  })
  .openapi("AssignRiderBody");

export const reviewReplySchema = z
  .object({ reply: z.string().trim().min(1).max(1000) })
  .openapi("ReviewReplyBody");

// ─── Store drivers ───────────────────────────────────────────────────

export const StoreDriverSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    kind: z.enum(["blink", "external"]),
    rider_user_id: z.string().nullable(),
    full_name: z.string(),
    phone: z.string().nullable(),
    vehicle_type: z.string().nullable(),
    plate_number: z.string().nullable(),
    notes: z.string().nullable(),
    status: z.enum(["invited", "active", "inactive", "declined"]),
    avatar: z.string().nullable(),
    deliveries: z.number().int(),
    on_delivery: z.boolean(),
    created_at: z.string(),
  })
  .openapi("StoreDriver");

export const StoreDriverListResponse = z
  .object({ drivers: z.array(StoreDriverSchema) })
  .openapi("StoreDriverListResponse");
export const StoreDriverResponse = z
  .object({ driver: StoreDriverSchema })
  .openapi("StoreDriverResponse");

export const createDriverSchema = z
  .object({
    kind: z.enum(["blink", "external"]),
    /** Blink rider to invite (from GET /merchant/riders/lookup). */
    rider_id: z.string().uuid().optional(),
    full_name: z.string().trim().min(1).optional(),
    phone: z.string().trim().min(6).optional(),
    vehicle_type: z.string().optional(),
    plate_number: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine((b) => (b.kind === "blink" ? !!b.rider_id : !!b.full_name && !!b.phone), {
    message: "blink needs rider_id; external needs full_name and phone",
  })
  .openapi("CreateDriverBody");

export const updateDriverSchema = z
  .object({
    full_name: z.string().trim().min(1).optional(),
    phone: z.string().trim().min(6).optional(),
    vehicle_type: z.string().nullable().optional(),
    plate_number: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  })
  .openapi("UpdateDriverBody");

export const riderLookupSchema = z.object({
  phone: z.string().min(6).openapi({ description: "Rider phone, any format (0555…, +213 555…)" }),
});

export const RiderLookupResponse = z
  .object({
    rider: z.object({
      id: z.string(),
      name: z.string(),
      phone: z.string().nullable(),
      avatar: z.string().nullable(),
      vehicle_type: z.string().nullable(),
      deliveries: z.number().int(),
    }),
  })
  .openapi("RiderLookupResponse");

// ─── Product categories (per store) ──────────────────────────────────

export const StoreCategoryListResponse = z
  .object({
    categories: z.array(
      z.object({ name: z.string(), product_count: z.number().int() }).openapi("StoreCategory")
    ),
  })
  .openapi("StoreCategoryListResponse");

export const saveCategoriesSchema = z
  .object({
    /** The full ordered list of the store's categories. */
    categories: z.array(z.string().trim().min(1)).max(50),
    /** Renames to apply to products ({from → to}). */
    renames: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
  })
  .openapi("SaveCategoriesBody");

// ─── Earnings ────────────────────────────────────────────────────────

export const earningsQuerySchema = z.object({
  period: periodSchema.default("this_month"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  store_id: z.string().uuid().optional(),
});

const breakdownSchema = z
  .object({
    total: z.number(),
    details: z.array(z.object({ key: z.string(), amount: z.number() })),
  })
  .openapi("EarningsBreakdownModel");

export const MerchantOperationSchema = z
  .object({
    id: z.string(),
    type: z.enum(["sale", "bonus", "dues", "refund"]),
    reference: z.string().nullable(),
    store_id: z.string().nullable(),
    store_name: z.string().nullable(),
    created_at: z.string(),
    amount: z.number(),
    status: z.enum(["completed", "pending", "cancelled"]),
  })
  .openapi("MerchantOperation");

export const MerchantEarningsResponse = z
  .object({
    net_income: z.number(),
    sales_count: z.number().int(),
    gross_income: breakdownSchema,
    commissions_taxes: breakdownSchema,
    operations: z.array(MerchantOperationSchema),
  })
  .openapi("MerchantEarningsResponse");

// ─── Dues (Blink Cash) ───────────────────────────────────────────────

export const DuesPaymentSchema = rowSchema(merchantDuesPayments, "DuesPaymentRow")
  .extend({ store_name: z.string().nullable() })
  .openapi("DuesPayment");

export const MerchantDuesResponse = z
  .object({
    total_dues: z.number(),
    commission_rate: z.number(),
    stores: z.array(
      z
        .object({
          store_id: z.string(),
          store_name: z.string(),
          total_profit: z.number(),
          dues_payable: z.number(),
          fees: z.number(),
        })
        .openapi("StoreDues")
    ),
    payments: z.array(DuesPaymentSchema),
  })
  .openapi("MerchantDuesResponse");

export const payDuesSchema = z
  .object({
    store_id: z.string().uuid().optional(),
    amount: z.number().positive(),
    method: z.string().min(1),
    pin: z.string().regex(/^\d{4,6}$/),
  })
  .openapi("PayDuesBody");

export const PayDuesResponse = z.object({ payment: DuesPaymentSchema }).openapi("PayDuesResponse");

// ─── Dashboard (insights) ────────────────────────────────────────────
// Shape mirrors the app's DashTab / GlobalTab (store/merchant/merchant-dashboard-store.ts).

const headlineSchema = z
  .object({
    label: z.string(),
    value: z.string(),
    delta: z.string().optional(),
    deltaDir: z.enum(["up", "down"]).optional(),
    sub: z.string(),
  })
  .openapi("DashHeadline");

const insightSchema = z
  .object({
    heading: z.string(),
    bullets: z.array(z.string()),
    recommendation: z.object({
      text: z.string(),
      cta: z.enum([
        "create_promo",
        "set_hours",
        "build_pack",
        "reply",
        "view_playbook",
        "boost_store",
        "open_reviews",
      ]),
    }),
  })
  .openapi("DashInsight");

export const DashTabSchema = z
  .object({
    key: z.enum(["revenue", "orders", "products", "hours", "ratings", "bundles"]),
    headline: headlineSchema,
    miniStats: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
    chartTitle: z.string(),
    chartType: z.enum(["vbars", "hbars"]),
    vbars: z
      .array(z.object({ label: z.string(), value: z.number(), highlight: z.boolean().optional() }))
      .optional(),
    hbars: z
      .array(z.object({ label: z.string(), value: z.number(), display: z.string() }))
      .optional(),
    aiComment: z.string(),
    table: z.object({
      columns: z.array(z.object({ key: z.string(), align: z.enum(["left", "right"]) })),
      rows: z.array(z.array(z.string())),
    }),
    insight: insightSchema,
  })
  .openapi("DashTab");

export const GlobalTabSchema = z
  .object({
    key: z.enum(["overview", "revenue", "orders", "ratings", "bundles"]),
    headline: headlineSchema,
    leaderboardTitle: z.string(),
    metric: z.enum(["revenue", "orders", "rating", "bundle"]),
    aiComment: z.string(),
    insight: insightSchema,
    tableMode: z.enum(["comparison", "single"]),
  })
  .openapi("GlobalTab");

export const dashboardQuerySchema = z.object({
  store_id: z.string().uuid().optional(),
  period: z.enum(["today", "this_week", "this_month", "this_year"]).default("this_week"),
});

export const MerchantDashboardResponse = z
  .object({ tabs: z.array(DashTabSchema) })
  .openapi("MerchantDashboardResponse");

export const MerchantGlobalDashboardResponse = z
  .object({
    tabs: z.array(GlobalTabSchema),
    stores: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          revenue: z.number(),
          orders: z.number().int(),
          rating: z.number(),
          bundle: z.number(),
        })
        .openapi("GlobalStoreRow")
    ),
  })
  .openapi("MerchantGlobalDashboardResponse");

// ─── Uploads ─────────────────────────────────────────────────────────

export const merchantUploadSchema = z
  .object({
    base64: z.string().min(1),
    content_type: z.string().min(1),
    kind: z.enum(["image", "document"]).default("image"),
  })
  .openapi("MerchantUploadBody");

export const MerchantUploadResponse = z
  .object({ url: z.string() })
  .openapi("MerchantUploadResponse");

// ─── Staff review (admin-merchant tag; excluded from the app client) ─

export const reviewStoreSchema = z
  .object({ status: z.enum(["active", "inactive", "under_review"]) })
  .openapi("ReviewStoreBody");

export const reviewProductSchema = z
  .object({
    review_status: z.enum(["approved", "pending", "rejected"]).optional(),
    suggestion_status: z.enum(["accepted", "rejected"]).optional(),
  })
  .openapi("ReviewProductBody");

// ─── Customer: rate a delivered order's store ────────────────────────

export const rateOrderSchema = z
  .object({ rating: z.number().int().min(1).max(5), review: z.string().max(1000).optional() })
  .openapi("RateOrderBody");

// ─── Strategy ────────────────────────────────────────────────────────

export const strategyQuerySchema = z.object({ store_id: z.string().uuid().optional() });

const strategyActionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["photos", "restock", "reviews", "pricing", "catalog", "bundle", "hours", "goal"]),
    priority: z.enum(["high", "medium", "low"]),
    title: z.string(),
    detail: z.string(),
    impact: z.string(),
    count: z.number().int().optional(),
    /** Product ids the action is about (photos/restock/pricing). */
    product_ids: z.array(z.string()).optional(),
  })
  .openapi("StrategyAction");

const pricingSuggestionSchema = z
  .object({
    product_id: z.string(),
    title: z.string(),
    image: z.string(),
    current_price: z.number(),
    suggested_price: z.number(),
    market_price: z.number(),
    reason: z.string(),
    impact: z.string(),
  })
  .openapi("PricingSuggestion");

const promotionSuggestionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["bundle_discount", "buy_x_get_y", "free_delivery", "happy_hour"]),
    title: z.string(),
    detail: z.string(),
    impact: z.string(),
    /** Ready-to-create pack (POST /merchant/stores/{id}/packs). */
    pack: z
      .object({
        name: z.string(),
        items: z.array(
          z.object({
            product_id: z.string(),
            quantity: z.number().int(),
            qty_promo_enabled: z.boolean(),
            buy_qty: z.number().int(),
            get_qty: z.number().int(),
          })
        ),
        discount_enabled: z.boolean(),
        discount_percent: z.number().int(),
        free_delivery: z.boolean(),
      })
      .nullable(),
  })
  .openapi("PromotionSuggestion");

const benchmarkMetricSchema = z
  .object({
    key: z.enum(["rating", "repeat_customers", "avg_order_value", "orders_per_day", "catalog_size", "acceptance_rate"]),
    you: z.number(),
    area: z.number(),
    better: z.boolean(),
  })
  .openapi("BenchmarkMetric");

export const MerchantSuggestionSchema = z
  .object({
    id: z.string(),
    store_id: z.string().nullable(),
    source: z.enum(["chat", "system"]),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    data: z.record(z.string(), z.unknown()),
    status: z.enum(["new", "applied", "dismissed"]),
    created_at: z.string(),
  })
  .openapi("MerchantSuggestion");

export const MerchantStrategyResponse = z
  .object({
    store_id: z.string(),
    summary: z.object({ open_actions: z.number().int(), potential_gain: z.number() }),
    action_plan: z.array(strategyActionSchema),
    pricing: z.array(pricingSuggestionSchema),
    promotions: z.array(promotionSuggestionSchema),
    benchmark: z.object({
      rank_percent: z.number().int(),
      compared_stores: z.number().int(),
      metrics: z.array(benchmarkMetricSchema),
    }),
    missed_demand: z.array(
      z
        .object({
          library_product_id: z.string(),
          title: z.string(),
          image: z.string(),
          category: z.string(),
          stores_stocking: z.number().int(),
          reason: z.enum(["popular_nearby", "out_of_stock"]),
          product_id: z.string().nullable(),
        })
        .openapi("MissedDemandItem")
    ),
    weekly_goal: z.object({
      goal: z.number(),
      current: z.number(),
      days: z.array(z.object({ label: z.string(), revenue: z.number(), is_today: z.boolean() })),
      past_weeks: z.array(z.object({ label: z.string(), revenue: z.number(), goal: z.number(), hit: z.boolean() })),
    }),
    reputation: z.object({
      rating: z.number(),
      review_count: z.number().int(),
      distribution: z.array(z.object({ stars: z.number().int(), count: z.number().int() })),
      needs_reply: z.number().int(),
      reviews: z.array(
        z
          .object({
            order_id: z.string(),
            customer_name: z.string(),
            rating: z.number().int(),
            review: z.string().nullable(),
            reply: z.string().nullable(),
            created_at: z.string(),
          })
          .openapi("StoreReview")
      ),
    }),
    suggestions: z.array(MerchantSuggestionSchema),
  })
  .openapi("MerchantStrategyResponse");

export const updateSuggestionSchema = z
  .object({ status: z.enum(["new", "applied", "dismissed"]) })
  .openapi("UpdateSuggestionBody");
export const MerchantSuggestionResponse = z
  .object({ suggestion: MerchantSuggestionSchema })
  .openapi("MerchantSuggestionResponse");

export const AiMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    suggestion: MerchantSuggestionSchema.nullable(),
    created_at: z.string(),
  })
  .openapi("MerchantAiMessage");

export const AiChatHistoryResponse = z
  .object({ messages: z.array(AiMessageSchema) })
  .openapi("MerchantAiChatHistoryResponse");

export const sendAiMessageSchema = z
  .object({
    store_id: z.string().uuid().optional(),
    message: z.string().trim().min(1).max(2000),
  })
  .openapi("SendMerchantAiMessageBody");

export const SendAiMessageResponse = z
  .object({ messages: z.array(AiMessageSchema) })
  .openapi("SendMerchantAiMessageResponse");

// ─── Rider side: location + store invitations ────────────────────────

export const riderLocationSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    is_available: z.boolean().optional(),
  })
  .openapi("RiderLocationBody");

export const StoreInvitationSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    store_name: z.string(),
    store_image: z.string(),
    store_address: z.string().nullable(),
    status: z.enum(["invited", "active", "inactive", "declined"]),
    created_at: z.string(),
  })
  .openapi("StoreInvitation");

export const StoreInvitationListResponse = z
  .object({ invitations: z.array(StoreInvitationSchema) })
  .openapi("StoreInvitationListResponse");

export const respondInvitationSchema = z
  .object({ accept: z.boolean() })
  .openapi("RespondInvitationBody");
