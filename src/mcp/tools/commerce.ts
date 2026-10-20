import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange, sanitizeSearch } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";
import { pricePack, type PackProductLike, type PackRowLike } from "../../lib/pack-pricing";
import { promotionAvailability, presentCoupon, type PromotionAvailability } from "../../lib/coupons";
import { documentsStatus, STORE_DOC_KEYS } from "../../lib/store-documents";
import { getAllPrices, getPrices, type PricingContext, type PricingKey } from "../../lib/pricing";
import { PRICING_GROUPS, PRICING_SCOPES, PRICING_KEYS } from "../../lib/pricing/catalog";
import { orderPricingContext } from "../../lib/pricing/fees";
import { SIM_DEFAULTS, simulate, type SimPrices } from "../../lib/pricing/simulate";

const ROLES = ["commerce_admin", "ops_admin"] as const;
const PRICING_ROLES = ["commerce_admin", "ops_admin", "finance_admin"] as const;

type Row = Record<string, any>;

const fullName = (u?: { first_name: string | null; last_name: string | null } | null) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null;

async function userNames(ids: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const map = new Map<string, string | null>();
  if (!unique.length) return map;
  const { data } = must(await supabaseAdmin.from("users").select("id, first_name, last_name").in("id", unique));
  for (const u of data as Row[]) map.set(u.id, fullName(u as any));
  return map;
}

async function storeNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  const map = new Map<string, string>();
  if (!unique.length) return map;
  const { data } = must(await supabaseAdmin.from("stores").select("id, name").in("id", unique));
  for (const s of data as Row[]) map.set(s.id, s.name);
  return map;
}

const num = (v: unknown) => (v == null ? null : Number(v));

/** Documents the staff still has to look at (uploaded, no current verdict). Never exposes the file values. */
export function pendingDocKeys(documents: unknown, review: unknown): string[] {
  const st = documentsStatus(documents, review) as Record<string, any>;
  return STORE_DOC_KEYS.filter((k) => st[k].status === "pending");
}

/** Pack status → the staff-facing state. */
export function packState(p: { status: string; review_note: string | null }): "review" | "live" | "held" | "paused" | "archived" {
  if (p.status === "under_review") return "review";
  if (p.status === "active") return "live";
  if (p.status === "archived") return "archived";
  return p.review_note?.trim() ? "held" : "paused";
}

// ─── 1. list_store_products ─────────────────────────────────────────
export const listStoreProducts = defineTool({
  name: "list_store_products",
  title: "List store products",
  description:
    "Merchant catalog products (read-only), newest first: name, price, blink_price (DZD), stock, available, review status (approved|pending|rejected), price-suggestion status, category. Filters: store_id, q (title/barcode contains), review_status.",
  roles: [...ROLES],
  input: {
    store_id: uuidField("Store id").optional(),
    q: z.string().max(80).optional().describe("Title or barcode contains"),
    review_status: z.enum(["approved", "pending", "rejected"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("store_products")
      .select(
        "id, store_id, title, price, blink_price, stock, is_available, review_status, suggested_price, suggestion_status, review_note, category, brand, barcode, library_product_id, updated_at",
        { count: "exact" }
      );
    if (a.store_id) q = q.eq("store_id", a.store_id);
    if (a.review_status) q = q.eq("review_status", a.review_status);
    const s = a.q ? sanitizeSearch(a.q) : "";
    if (s) q = q.or(`title.ilike.%${s}%,barcode.ilike.%${s}%`);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Row[];
    const names = await storeNames(rows.map((r) => r.store_id));
    const items = rows.map((r) => ({
      id: r.id,
      store_id: r.store_id,
      store_name: names.get(r.store_id) ?? null,
      name: r.title,
      price: num(r.price),
      blink_price: num(r.blink_price),
      stock: r.stock,
      available: r.is_available,
      review_status: r.review_status,
      suggested_price: num(r.suggested_price),
      suggestion_status: r.suggestion_status,
      review_note: r.review_note,
      category: r.category,
      brand: r.brand,
      barcode: r.barcode,
      from_library: !!r.library_product_id,
      updated_at: r.updated_at,
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ─── 2. catalog_review_queue ────────────────────────────────────────
const DOC_SCAN_CAP = 500;

export const catalogReviewQueue = defineTool({
  name: "catalog_review_queue",
  title: "Catalog review queue",
  description:
    "What waits for staff review (read-only): counts plus the oldest 5 of pending products, pending price suggestions, stores under review, packs under review, and stores with documents awaiting a verdict.",
  roles: [...ROLES],
  input: {},
  handler: async () => {
    const head = { count: "exact" as const };
    const [products, suggestions, stores, packs, docStores] = await Promise.all([
      supabaseAdmin
        .from("store_products")
        .select("id, store_id, title, price, created_at", head)
        .eq("review_status", "pending")
        .order("created_at", { ascending: true })
        .limit(5),
      supabaseAdmin
        .from("store_products")
        .select("id, store_id, title, price, suggested_price, updated_at", head)
        .eq("suggestion_status", "pending")
        .order("updated_at", { ascending: true })
        .limit(5),
      supabaseAdmin
        .from("stores")
        .select("id, name, city, created_at, updated_at", head)
        .eq("status", "under_review")
        .order("updated_at", { ascending: true })
        .limit(5),
      supabaseAdmin
        .from("store_packs")
        .select("id, store_id, name, free_delivery, created_at", head)
        .eq("status", "under_review")
        .order("created_at", { ascending: true })
        .limit(5),
      supabaseAdmin
        .from("stores")
        .select("id, name, documents, document_review, updated_at")
        .order("updated_at", { ascending: true })
        .limit(DOC_SCAN_CAP),
    ]);
    const p = must(products), sg = must(suggestions), st = must(stores), pk = must(packs), ds = must(docStores);
    const names = await storeNames([...(p.data as Row[]), ...(sg.data as Row[]), ...(pk.data as Row[])].map((r) => r.store_id));
    const withStore = (r: Row) => ({ ...r, store_name: names.get(r.store_id) ?? null });
    const docRows = (ds.data as Row[])
      .map((s) => ({ id: s.id, name: s.name, pending_documents: pendingDocKeys(s.documents, s.document_review), updated_at: s.updated_at }))
      .filter((s) => s.pending_documents.length > 0);
    return {
      data: {
        pending_products: { count: p.count ?? 0, oldest: (p.data as Row[]).map(withStore) },
        pending_price_suggestions: { count: sg.count ?? 0, oldest: (sg.data as Row[]).map(withStore) },
        stores_in_review: { count: st.count ?? 0, oldest: st.data },
        packs_in_review: { count: pk.count ?? 0, oldest: (pk.data as Row[]).map(withStore) },
        store_documents_pending: {
          stores_count: docRows.length,
          truncated: (ds.data as Row[]).length >= DOC_SCAN_CAP,
          oldest: docRows.slice(0, 5),
        },
      },
      rowCount: 5,
    };
  },
});

// ─── 3. list_price_changes ──────────────────────────────────────────
export const listPriceChanges = defineTool({
  name: "list_price_changes",
  title: "List product price changes",
  description:
    "Product price history (read-only), newest first: old → new price and blink_price (DZD), source (created|merchant|staff|library|system|baseline), who changed it. Filters: store_id, product_id, source, created_from/created_to.",
  roles: [...PRICING_ROLES],
  input: {
    store_id: uuidField("Store id").optional(),
    product_id: uuidField("Product id").optional(),
    source: z.enum(["created", "merchant", "staff", "library", "system", "baseline"]).optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("store_product_price_changes")
      .select("id, product_id, store_id, old_price, new_price, old_blink_price, new_blink_price, source, changed_by, changed_at", {
        count: "exact",
      });
    if (a.store_id) q = q.eq("store_id", a.store_id);
    if (a.product_id) q = q.eq("product_id", a.product_id);
    if (a.source) q = q.eq("source", a.source);
    const r = dateRange(a.created_from, a.created_to);
    if (r.gte) q = q.gte("changed_at", r.gte);
    if (r.lt) q = q.lt("changed_at", r.lt);
    const { data, count } = must(await q.order("changed_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Row[];
    const [users, stores, prods] = await Promise.all([
      userNames(rows.map((x) => x.changed_by)),
      storeNames(rows.map((x) => x.store_id)),
      (async () => {
        const ids = [...new Set(rows.map((x) => x.product_id))];
        const m = new Map<string, string>();
        if (ids.length) {
          const { data: p } = must(await supabaseAdmin.from("store_products").select("id, title").in("id", ids));
          for (const x of p as Row[]) m.set(x.id, x.title);
        }
        return m;
      })(),
    ]);
    const items = rows.map((x) => ({
      id: x.id,
      product_id: x.product_id,
      product_name: prods.get(x.product_id) ?? null,
      store_id: x.store_id,
      store_name: stores.get(x.store_id) ?? null,
      old_price: num(x.old_price),
      new_price: num(x.new_price),
      old_blink_price: num(x.old_blink_price),
      new_blink_price: num(x.new_blink_price),
      source: x.source,
      changed_by: x.changed_by,
      changed_by_name: x.changed_by ? users.get(x.changed_by) ?? null : null,
      changed_at: x.changed_at,
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ─── 4. list_packs ──────────────────────────────────────────────────
export const listPacks = defineTool({
  name: "list_packs",
  title: "List product packs",
  description:
    "Store packs/bundles (read-only), newest first, with computed price (original, savings, price in DZD) and free-delivery flag. status: review (under_review) | live (active) | held (inactive + staff note) | paused (inactive) | archived. Filters: store_id, status.",
  roles: [...ROLES],
  input: {
    store_id: uuidField("Store id").optional(),
    status: z.enum(["review", "live", "held", "paused", "archived"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("store_packs")
      .select(
        "id, store_id, name, description, image, items, discount_enabled, discount_percent, free_delivery, status, review_note, reviewed_at, created_at, updated_at",
        { count: "exact" }
      );
    if (a.store_id) q = q.eq("store_id", a.store_id);
    switch (a.status) {
      case "review": q = q.eq("status", "under_review"); break;
      case "live": q = q.eq("status", "active"); break;
      case "archived": q = q.eq("status", "archived"); break;
      case "held": q = q.eq("status", "inactive").not("review_note", "is", null).neq("review_note", ""); break;
      case "paused": q = q.eq("status", "inactive").or("review_note.is.null,review_note.eq."); break;
    }
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Row[];
    const productIds = [...new Set(rows.flatMap((p) => ((p.items ?? []) as Row[]).map((i) => i.product_id)))].filter((id) =>
      /^[0-9a-f-]{36}$/i.test(String(id))
    );
    const products = new Map<string, PackProductLike & { is_available: boolean; review_status: string }>();
    if (productIds.length) {
      const { data: pr } = must(
        await supabaseAdmin.from("store_products").select("id, title, price, unit, is_available, review_status").in("id", productIds)
      );
      for (const x of pr as Row[]) products.set(x.id, x as any);
    }
    const visible = new Map([...products].filter(([, v]) => v.is_available && v.review_status === "approved"));
    const names = await storeNames(rows.map((r) => r.store_id));
    const items = rows.map((r) => {
      const priced = pricePack(r as PackRowLike, products);
      const sellable = pricePack(r as PackRowLike, visible) !== null;
      return {
        id: r.id,
        store_id: r.store_id,
        store_name: names.get(r.store_id) ?? null,
        name: r.name,
        state: packState(r as any),
        status: r.status,
        free_delivery: r.free_delivery,
        free_delivery_reviewed: !!r.reviewed_at,
        review_note: r.review_note,
        discount_percent: priced?.discount_percent ?? (r.discount_enabled ? r.discount_percent : 0),
        price_summary: priced
          ? { item_count: priced.item_count, original_price: priced.original_price, savings: priced.savings, price: priced.price }
          : null,
        all_products_sellable: sellable,
        updated_at: r.updated_at,
      };
    });
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ─── 5. get_pricing_config ──────────────────────────────────────────
export const statusOfOverride = (
  o: { archived_at?: string | null; starts_at: string | null; ends_at: string | null },
  now = Date.now()
): "active" | "scheduled" | "ended" | "archived" => {
  if (o.archived_at) return "archived";
  if (o.ends_at && Date.parse(o.ends_at) <= now) return "ended";
  if (o.starts_at && Date.parse(o.starts_at) > now) return "scheduled";
  return "active";
};

export const getPricingConfig = defineTool({
  name: "get_pricing_config",
  title: "Get pricing config",
  description:
    "Current fee/commission/tax defaults (DZD; rates are fractions) and active or upcoming overrides with scope (service, wilaya, merchant, agent), value, dates and note. Optional key filter.",
  roles: [...PRICING_ROLES],
  input: { key: z.enum(PRICING_KEYS).optional().describe("Only this pricing key") },
  handler: async (a) => {
    const nowIso = new Date().toISOString();
    let oq = supabaseAdmin
      .from("pricing_overrides")
      .select("id, key, service, wilaya_code, merchant_id, agent_id, value, starts_at, ends_at, note, created_at")
      .is("archived_at", null)
      .or(`ends_at.is.null,ends_at.gt.${nowIso}`)
      .order("created_at", { ascending: false })
      .limit(200);
    if (a.key) oq = oq.eq("key", a.key);
    const [prices, ov] = await Promise.all([getAllPrices(), oq]);
    const overrides = must(ov).data as unknown as Row[];
    const partners = await userNames(overrides.flatMap((o) => [o.merchant_id, o.agent_id]));
    const defaults = prices
      .filter((p) => !a.key || p.key === a.key)
      .map((p) => ({ key: p.key, group: PRICING_GROUPS[p.key], value: p.value, scopes: PRICING_SCOPES[p.key] }));
    return {
      data: {
        defaults,
        overrides: overrides.map((o) => ({
          ...o,
          status: statusOfOverride(o as any),
          partner_name: partners.get(o.merchant_id ?? o.agent_id) ?? null,
        })),
        overrides_truncated: overrides.length >= 200,
      },
      rowCount: defaults.length + overrides.length,
    };
  },
});

// ─── 6. simulate_price ──────────────────────────────────────────────
export const SIM_KEYS = {
  store: ["service_fee", "merchant_commission_rate", "stamp_duty_rate", "rider_commission_rate"],
  courier: ["courier_fare", "fare_multiplier", "rider_commission_rate"],
  ride: ["ride_fare", "fare_multiplier", "rider_commission_rate"],
  deposit: ["blink_cash_fee_rate", "agent_platform_share", "agent_tax_rate"],
  withdrawal: ["blink_cash_fee_rate", "agent_platform_share", "agent_tax_rate"],
} as const satisfies Record<string, readonly PricingKey[]>;

export const simulatePrice = defineTool({
  name: "simulate_price",
  title: "Simulate price",
  description:
    "Pure what-if (no writes): who gets what for one transaction at current prices. scenario store (subtotal, delivery_fee) | courier (km, stops, vehicle) | ride (km) | deposit/withdrawal (amount). Optional wilaya_code, merchant_id, agent_id, store_id, at.",
  roles: [...PRICING_ROLES],
  input: {
    scenario: z.enum(["store", "courier", "ride", "deposit", "withdrawal"]),
    wilaya_code: z.string().max(8).optional(),
    merchant_id: uuidField("Merchant user id (partner override)").optional(),
    agent_id: uuidField("Agent user id (partner override)").optional(),
    store_id: uuidField("Store id (store scenario: derives merchant, wilaya and delivery fee)").optional(),
    at: z.string().datetime().optional().describe("Price as of this ISO instant (default now)"),
    subtotal: z.number().nonnegative().optional().describe(`DZD, default ${SIM_DEFAULTS.subtotal}`),
    delivery_fee: z.number().nonnegative().optional().describe(`DZD, default ${SIM_DEFAULTS.delivery_fee}`),
    km: z.number().positive().max(500).optional().describe(`default ${SIM_DEFAULTS.km}`),
    stops: z.number().int().min(1).max(10).optional(),
    vehicle: z.enum(["bicycle", "motorcycle"]).optional(),
    amount: z.number().positive().optional().describe(`DZD, default ${SIM_DEFAULTS.amount}`),
  },
  handler: async (a) => {
    const { scenario } = a;
    const at = a.at ? new Date(a.at) : undefined;
    let ctx: PricingContext = {
      service: scenario === "store" ? "merchant" : scenario,
      wilaya: a.wilaya_code ?? null,
      merchantId: a.merchant_id ?? null,
      agentId: a.agent_id ?? null,
      at,
    };
    let delivery = a.delivery_fee;
    if (scenario === "store" && a.store_id) {
      const sc = await orderPricingContext({ type: "merchant", storeId: a.store_id });
      ctx = { ...ctx, ...sc, wilaya: sc.wilaya ?? ctx.wilaya, at };
      if (delivery == null) {
        const { data } = await supabaseAdmin.from("stores").select("delivery_fee").eq("id", a.store_id).maybeSingle();
        if (data?.delivery_fee != null) delivery = Number(data.delivery_fee);
      }
    }
    const keys = SIM_KEYS[scenario];
    const results = await getPrices(keys, ctx);
    const prices: SimPrices = {};
    for (const k of keys) (prices as Record<string, unknown>)[k] = results[k as keyof typeof results].value;
    const result = simulate(
      scenario,
      { subtotal: a.subtotal, delivery_fee: delivery ?? SIM_DEFAULTS.delivery_fee, km: a.km, stops: a.stops, vehicle: a.vehicle, amount: a.amount },
      prices
    );
    return {
      data: {
        scenario,
        ...result,
        values: keys.map((k) => {
          const r = results[k as keyof typeof results];
          return { key: k, value: r.value, override_id: r.overrideId };
        }),
      },
      rowCount: 1,
    };
  },
});

// ─── 7. list_promotions / list_coupons ──────────────────────────────
const PROMO_SCAN = 100;
const AVAILABILITY = ["live", "scheduled", "paused", "ended", "sold_out", "budget_spent", "archived"] as const;

export const listPromotions = defineTool({
  name: "list_promotions",
  title: "List promotions",
  description:
    "Promotions and deals (read-only), newest first, with availability (live|scheduled|paused|ended|sold_out|budget_spent|archived), discount, caps, budget, coupons issued/used, DZD discount given, orders. Filters: status, kind (promo|deal).",
  roles: [...ROLES],
  input: {
    status: z.enum(AVAILABILITY).optional().describe("Computed availability"),
    kind: z.enum(["promo", "deal"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { limit, offset } = page(a);
    let q = supabaseAdmin
      .from("promotions")
      .select(
        "id, kind, category, title, code, store_id, discount_type, discount_value, min_order, max_discount, starts_at, ends_at, is_active, max_coupons, discount_budget, archived_at, created_at"
      );
    if (a.kind) q = q.eq("kind", a.kind);
    const { data } = must(await q.order("created_at", { ascending: false }).limit(PROMO_SCAN));
    const rows = data as unknown as Row[];
    const stats = must(await supabaseAdmin.rpc("promotion_stats", {})).data as unknown as Row[] | null;
    const byId = new Map((stats ?? []).map((s) => [s.promotion_id, s]));
    const now = Date.now();
    const all = rows.map((p) => {
      const s = byId.get(p.id);
      const usage = { issued: Number(s?.issued ?? 0), discount_given: Number(s?.discount_given ?? 0) };
      const availability: PromotionAvailability = promotionAvailability(p, usage, now);
      return {
        id: p.id,
        kind: p.kind,
        category: p.category,
        title: p.title,
        code: p.code,
        store_id: p.store_id,
        availability,
        discount_type: p.discount_type,
        discount_value: num(p.discount_value),
        min_order: num(p.min_order),
        max_discount: num(p.max_discount),
        starts_at: p.starts_at,
        ends_at: p.ends_at,
        max_coupons: p.max_coupons,
        discount_budget: num(p.discount_budget),
        coupons_issued: usage.issued,
        coupons_used: Number(s?.used ?? 0),
        discount_given: usage.discount_given,
        orders: Number(s?.orders ?? 0),
      };
    });
    const filtered = a.status ? all.filter((p) => p.availability === a.status) : all;
    const items = filtered.slice(offset, offset + limit);
    const next = offset + items.length < filtered.length ? offset + items.length : null;
    return {
      data: { items, total: filtered.length, next_offset: next, scanned_latest: rows.length, truncated: rows.length >= PROMO_SCAN },
      rowCount: items.length,
    };
  },
});

export const listCoupons = defineTool({
  name: "list_coupons",
  title: "List coupons",
  description:
    "Customer coupons (read-only), newest first: status (active|used|expired|revoked), customer name, discount, min order (DZD), expiry, source (promotion|referral|staff), promotion. Filters: user_id, status.",
  roles: [...ROLES],
  input: {
    user_id: uuidField("Customer user id").optional(),
    status: z.enum(["active", "used", "expired", "revoked"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const nowIso = new Date().toISOString();
    let q = supabaseAdmin
      .from("customer_coupons")
      .select(
        "id, user_id, promotion_id, code, title, discount_type, discount_value, min_order, max_discount, expires_at, used_at, order_id, revoked_at, source, note, created_at",
        { count: "exact" }
      );
    if (a.user_id) q = q.eq("user_id", a.user_id);
    switch (a.status) {
      case "revoked": q = q.not("revoked_at", "is", null); break;
      case "used": q = q.is("revoked_at", null).not("used_at", "is", null); break;
      case "expired": q = q.is("revoked_at", null).is("used_at", null).lt("expires_at", nowIso); break;
      case "active": q = q.is("revoked_at", null).is("used_at", null).or(`expires_at.is.null,expires_at.gte.${nowIso}`); break;
    }
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Row[];
    const names = await userNames(rows.map((r) => r.user_id));
    const items = rows.map((r) => {
      const c = presentCoupon(r) as Row;
      return {
        id: c.id,
        code: c.code,
        title: c.title,
        status: c.status,
        user_id: c.user_id,
        user_name: names.get(c.user_id) ?? null,
        discount_type: c.discount_type,
        discount_value: num(c.discount_value),
        discount_label: c.discount_label,
        min_order: num(c.min_order),
        max_discount: num(c.max_discount),
        expires_at: c.expires_at,
        used_at: c.used_at,
        order_id: c.order_id,
        revoked_at: c.revoked_at,
        source: c.source,
        promotion_id: c.promotion_id,
        note: c.note,
        created_at: c.created_at,
      };
    });
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ─── 8. search_library_products ─────────────────────────────────────
export const searchLibraryProducts = defineTool({
  name: "search_library_products",
  title: "Search library products",
  description:
    "Blink Library master catalog (read-only): name (en/fr/ar), barcode, brand, category, unit, status (published|draft|archived), cover-photo presence, stores stocking it. No price column exists. Filters: q (name/barcode/brand), category (English name), status.",
  roles: [...ROLES],
  input: {
    q: z.string().max(80).optional().describe("Name (any language), barcode or brand contains"),
    category: z.string().max(80).optional().describe("Category English name (see library categories)"),
    status: z.enum(["published", "draft", "archived"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("library_products")
      .select("id, name_en, name_fr, name_ar, barcode, brand, category, unit, photos, status, store_count, updated_at", { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    const cat = a.category ? sanitizeSearch(a.category) : "";
    if (cat) q = q.ilike("category", cat);
    const s = a.q ? sanitizeSearch(a.q) : "";
    if (s) q = q.or(`name_en.ilike.%${s}%,name_fr.ilike.%${s}%,name_ar.ilike.%${s}%,barcode.ilike.%${s}%,brand.ilike.%${s}%`);
    const { data, count } = must(await q.order("name_en", { ascending: true }).range(from, to));
    const items = (data as unknown as Row[]).map(({ photos, ...r }) => ({
      ...r,
      has_image: Array.isArray(photos) && photos.length > 0,
      photo_count: Array.isArray(photos) ? photos.length : 0,
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const COMMERCE_TOOLS = [
  listStoreProducts,
  catalogReviewQueue,
  listPriceChanges,
  listPacks,
  getPricingConfig,
  simulatePrice,
  listPromotions,
  listCoupons,
  searchLibraryProducts,
];
