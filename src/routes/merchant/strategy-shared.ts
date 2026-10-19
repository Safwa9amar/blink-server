// Strategy Improvement — computed from the store's real orders, catalog,
// ratings and how other stores on Blink compare. Rule-based (no AI needed);
// copy is English like the dashboard insights. Also feeds the merchant's
// "Efficiency" notifications (lib: generateImprovementNotifications).
import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { fullName, packNamesByStore, usersById } from "./orders-shared";
import { orderSale, round2, type StoreRow } from "./shared";

const DAY = 864e5;
const LOW_STOCK = 5;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fmt = (n: number) =>
  Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : `${Math.round(n)}`;

/** Start of the current week (Saturday 00:00, Algerian week). */
function weekStart(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7));
  return d;
}

interface Product {
  id: string;
  title: string;
  image: string;
  photos: string[] | null;
  price: number;
  blink_price: number;
  stock: number;
  is_available: boolean;
  review_status: string;
  category: string;
  library_product_id: string | null;
  barcode: string;
}

export async function computeStrategy(merchantId: string, store: StoreRow) {
  const now = Date.now();
  const since = new Date(now - 56 * DAY).toISOString(); // 8 weeks

  const [{ data: products }, { data: orders }, { data: otherStores }, packs, { data: suggestions }] =
    await Promise.all([
      supabaseAdmin.from("store_products").select("*").eq("store_id", store.id),
      supabaseAdmin
        .from("orders")
        .select(
          "id, customer_id, status, merchant_status, subtotal, items, store_rating, store_review, store_review_reply, created_at"
        )
        .eq("store_id", store.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false }),
      supabaseAdmin
        .from("stores")
        .select("id, rating, category_slugs")
        .eq("status", "active")
        .neq("id", store.id),
      packNamesByStore([store.id]),
      supabaseAdmin
        .from("merchant_suggestions")
        .select("*")
        .eq("merchant_id", merchantId)
        .or(`store_id.eq.${store.id},store_id.is.null`)
        .neq("status", "dismissed")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  const catalog = (products ?? []) as Product[];
  const all = (orders ?? []).map((o) => ({ ...o, subtotal: Number(o.subtotal) }));
  const delivered = all.filter((o) => o.status === "delivered");
  const live = catalog.filter((p) => p.review_status === "approved");

  // ── Action plan ──────────────────────────────────────────────────
  const noPhoto = live.filter((p) => !(p.photos?.length || p.image));
  const lowStock = live.filter((p) => p.stock <= LOW_STOCK);
  const unanswered = all.filter((o) => o.store_rating && o.store_rating <= 3 && !o.store_review_reply);
  const overpriced = live.filter((p) => p.blink_price > 0 && p.price > p.blink_price * 1.15);
  const weekRevenue = delivered
    .filter((o) => new Date(o.created_at) >= weekStart())
    .reduce((t, o) => t + orderSale(o), 0);
  const avgWeek = delivered.reduce((t, o) => t + orderSale(o), 0) / 8;

  const actions: any[] = [];
  if (noPhoto.length)
    actions.push({
      id: "photos",
      kind: "photos",
      priority: "high",
      title: `Add photos to ${noPhoto.length} product${noPhoto.length > 1 ? "s" : ""}`,
      detail: "Products with photos get noticeably more orders.",
      impact: "+15% views",
      count: noPhoto.length,
      product_ids: noPhoto.map((p) => p.id),
    });
  if (lowStock.length)
    actions.push({
      id: "restock",
      kind: "restock",
      priority: "high",
      title: `Restock ${lowStock.length} item${lowStock.length > 1 ? "s" : ""}`,
      detail: lowStock.slice(0, 3).map((p) => p.title).join(", ") + (lowStock.length > 3 ? "…" : ""),
      impact: "Avoid missed orders",
      count: lowStock.length,
      product_ids: lowStock.map((p) => p.id),
    });
  if (unanswered.length)
    actions.push({
      id: "reviews",
      kind: "reviews",
      priority: "medium",
      title: `Reply to ${unanswered.length} low review${unanswered.length > 1 ? "s" : ""}`,
      detail: "A quick reply wins back unhappy customers.",
      impact: "+0.2 ★",
      count: unanswered.length,
    });
  if (overpriced.length)
    actions.push({
      id: "pricing",
      kind: "pricing",
      priority: "medium",
      title: `Lower ${overpriced.length} price${overpriced.length > 1 ? "s" : ""}`,
      detail: "Priced more than 15% above the Blink reference.",
      impact: "+8% conversion",
      count: overpriced.length,
      product_ids: overpriced.map((p) => p.id),
    });
  const activePacks = (packs.get(store.id) ?? new Set()).size;
  if (activePacks < 2)
    actions.push({
      id: "bundle",
      kind: "bundle",
      priority: "low",
      title: "Run a bundle",
      detail: "Bundles raise the average basket.",
      impact: "+12% basket",
    });
  if (live.length < 15)
    actions.push({
      id: "catalog",
      kind: "catalog",
      priority: "low",
      title: "Grow your catalog",
      detail: `You list ${live.length} products — add popular items from the Blink Library.`,
      impact: "More searches",
    });
  if (!Number(store.weekly_goal))
    actions.push({
      id: "goal",
      kind: "goal",
      priority: "low",
      title: "Set a weekly goal",
      detail: "Track your revenue against a target.",
      impact: "Stay on track",
    });

  // ── Pricing suggestions (vs the same product in other stores) ─────
  const libIds = live.map((p) => p.library_product_id).filter(Boolean) as string[];
  const { data: market } = libIds.length
    ? await supabaseAdmin
        .from("store_products")
        .select("library_product_id, price")
        .in("library_product_id", libIds)
        .neq("store_id", store.id)
    : { data: [] as { library_product_id: string; price: number }[] };
  const marketAvg = new Map<string, number>();
  const grouped = new Map<string, number[]>();
  for (const m of market ?? []) {
    const arr = grouped.get(m.library_product_id) ?? [];
    arr.push(Number(m.price));
    grouped.set(m.library_product_id, arr);
  }
  for (const [k, v] of grouped) marketAvg.set(k, v.reduce((a, b) => a + b, 0) / v.length);

  const pricing = live
    .map((p) => {
      const ref = (p.library_product_id && marketAvg.get(p.library_product_id)) || p.blink_price;
      if (!ref || ref <= 0) return null;
      const diff = (p.price - ref) / ref;
      if (Math.abs(diff) < 0.08) return null;
      const suggested = Math.round(ref / 5) * 5;
      return {
        product_id: p.id,
        title: p.title,
        image: p.photos?.[0] ?? p.image ?? "",
        current_price: Number(p.price),
        suggested_price: suggested,
        market_price: round2(ref),
        reason:
          diff > 0
            ? `${Math.round(diff * 100)}% above the market price`
            : `${Math.round(-diff * 100)}% below the market price`,
        impact: diff > 0 ? "+8% orders" : `+${fmt(suggested - p.price)} Da / sale`,
      };
    })
    .filter(Boolean)
    .slice(0, 10) as any[];

  // ── Promotions (ready-to-create packs from the real catalog) ──────
  const sellers = new Map<string, number>();
  for (const o of delivered)
    for (const it of o.items ?? []) {
      if (it.pack_id) continue; // a pack line, named after the pack
      sellers.set(it.name, (sellers.get(it.name) ?? 0) + it.quantity);
    }
  const byTitle = new Map(live.filter((p) => p.is_available).map((p) => [p.title, p]));
  const top = [...sellers.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => byTitle.get(name))
    .filter(Boolean) as Product[];
  const pool = top.length >= 3 ? top : live.filter((p) => p.is_available);
  const item = (p: Product, quantity = 1, promo?: [number, number]) => ({
    product_id: p.id,
    quantity,
    qty_promo_enabled: !!promo,
    buy_qty: promo?.[0] ?? 2,
    get_qty: promo?.[1] ?? 1,
  });
  const promotions: any[] = [];
  if (pool.length >= 3)
    promotions.push({
      id: "bundle-top",
      kind: "bundle_discount",
      title: "Weekend 10% bundle",
      detail: `${pool[0].title}, ${pool[1].title} and ${pool[2].title} together.`,
      impact: "+12% basket",
      pack: {
        name: "Weekend Favourites",
        items: [item(pool[0]), item(pool[1]), item(pool[2])],
        discount_enabled: true,
        discount_percent: 10,
        free_delivery: false,
      },
    });
  if (pool.length >= 1)
    promotions.push({
      id: "b2g1",
      kind: "buy_x_get_y",
      title: `Buy 2, get 1 free — ${pool[0].title}`,
      detail: "Moves volume on your best seller.",
      impact: "+20% units",
      pack: {
        name: `${pool[0].title} 3-pack`,
        items: [item(pool[0], 3, [2, 1])],
        discount_enabled: false,
        discount_percent: 0,
        free_delivery: false,
      },
    });
  if (pool.length >= 2)
    promotions.push({
      id: "free-delivery",
      kind: "free_delivery",
      title: "Free delivery over a full basket",
      detail: `${pool[0].title} + ${pool[1].title} with free delivery.`,
      impact: "+15% conversion",
      pack: {
        name: "Free Delivery Pack",
        items: [item(pool[0], 2), item(pool[1], 2)],
        discount_enabled: false,
        discount_percent: 0,
        free_delivery: true,
      },
    });
  // Quietest 2-hour window → happy hour idea (no pack: informational).
  const slots = new Array(12).fill(0);
  for (const o of all) slots[Math.floor(new Date(o.created_at).getHours() / 2)]++;
  const openSlots = slots.map((v, i) => [v, i] as const).filter(([, i]) => i >= 4 && i <= 10);
  const quiet = openSlots.sort((a, b) => a[0] - b[0])[0];
  if (quiet)
    promotions.push({
      id: "happy-hour",
      kind: "happy_hour",
      title: `Happy hour ${quiet[1] * 2}:00–${quiet[1] * 2 + 2}:00`,
      detail: "Your quietest window — a small discount brings traffic.",
      impact: "Fills slow hours",
      pack: null,
    });

  // ── Benchmark vs other active stores ─────────────────────────────
  const others = (otherStores ?? []).filter((s) =>
    (s.category_slugs ?? []).some((c: string) => ((store.category_slugs as string[]) ?? []).includes(c))
  );
  const peers = others.length ? others : otherStores ?? [];
  const peerIds = peers.map((p) => p.id);
  const [{ data: peerOrders }, { data: peerProducts }] = peerIds.length
    ? await Promise.all([
        supabaseAdmin
          .from("orders")
          .select("store_id, customer_id, status, merchant_status, subtotal")
          .in("store_id", peerIds)
          .gte("created_at", since),
        supabaseAdmin.from("store_products").select("store_id").in("store_id", peerIds),
      ])
    : [{ data: [] as any[] }, { data: [] as any[] }];

  const metricsFor = (os: any[], rating: number, catalogSize: number) => {
    const d = os.filter((o) => o.status === "delivered");
    const byCustomer = new Map<string, number>();
    for (const o of d) byCustomer.set(o.customer_id, (byCustomer.get(o.customer_id) ?? 0) + 1);
    const repeat = byCustomer.size ? [...byCustomer.values()].filter((n) => n > 1).length / byCustomer.size : 0;
    const decided = os.filter((o) => o.merchant_status && o.merchant_status !== "pending");
    const accepted = decided.filter((o) => o.merchant_status !== "rejected");
    return {
      rating,
      repeat_customers: Math.round(repeat * 100),
      avg_order_value: d.length ? Math.round(d.reduce((t, o) => t + Number(o.subtotal), 0) / d.length) : 0,
      orders_per_day: round2(d.length / 56),
      catalog_size: catalogSize,
      acceptance_rate: decided.length ? Math.round((accepted.length / decided.length) * 100) : 100,
    };
  };
  const mine = metricsFor(all, Number(store.rating) || 0, live.length);
  const peerMetrics = peers.map((p) =>
    metricsFor(
      (peerOrders ?? []).filter((o) => o.store_id === p.id),
      Number(p.rating) || 0,
      (peerProducts ?? []).filter((x) => x.store_id === p.id).length
    )
  );
  const avg = (k: keyof typeof mine) =>
    peerMetrics.length ? round2(peerMetrics.reduce((t, m) => t + m[k], 0) / peerMetrics.length) : 0;
  const keys = Object.keys(mine) as (keyof typeof mine)[];
  const metrics = keys.map((k) => ({ key: k, you: mine[k], area: avg(k), better: mine[k] >= avg(k) }));
  const beatsCount = peerMetrics.filter((m) => mine.avg_order_value * mine.orders_per_day >= m.avg_order_value * m.orders_per_day).length;
  const rank_percent = peerMetrics.length ? Math.max(1, Math.round(100 - (beatsCount / peerMetrics.length) * 100)) : 1;

  // ── Missed demand ────────────────────────────────────────────────
  const ownLib = new Set(catalog.map((p) => p.library_product_id).filter(Boolean));
  const { data: popular } = await supabaseAdmin
    .from("library_products")
    .select("id, name_en, name_fr, photos, category, store_count")
    .eq("status", "published")
    .gt("store_count", 0)
    .order("store_count", { ascending: false })
    .limit(30);
  const missed_demand = [
    ...lowStock
      .filter((p) => p.stock === 0 || !p.is_available)
      .map((p) => ({
        library_product_id: p.library_product_id ?? p.id,
        title: p.title,
        image: p.photos?.[0] ?? p.image ?? "",
        category: p.category,
        stores_stocking: 0,
        reason: "out_of_stock" as const,
        product_id: p.id,
      })),
    ...(popular ?? [])
      .filter((l) => !ownLib.has(l.id))
      .slice(0, 8)
      .map((l) => ({
        library_product_id: l.id,
        title: l.name_en || l.name_fr,
        image: l.photos?.[0] ?? "",
        category: l.category,
        stores_stocking: l.store_count,
        reason: "popular_nearby" as const,
        product_id: null,
      })),
  ].slice(0, 12);

  // ── Weekly goal ──────────────────────────────────────────────────
  const ws = weekStart();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(ws.getTime() + i * DAY);
    const next = new Date(d.getTime() + DAY);
    const revenue = delivered
      .filter((o) => {
        const t = new Date(o.created_at);
        return t >= d && t < next;
      })
      .reduce((t, o) => t + orderSale(o), 0);
    return {
      label: DAY_LABELS[d.getDay()],
      revenue: round2(revenue),
      is_today: d.toDateString() === new Date().toDateString(),
    };
  });
  const goal = Number(store.weekly_goal) || 0;
  const past_weeks = [1, 2, 3].map((w) => {
    const start = new Date(ws.getTime() - w * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const revenue = delivered
      .filter((o) => {
        const t = new Date(o.created_at);
        return t >= start && t < end;
      })
      .reduce((t, o) => t + orderSale(o), 0);
    const label = `${start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${new Date(end.getTime() - DAY).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`;
    return { label, revenue: round2(revenue), goal, hit: goal > 0 && revenue >= goal };
  });

  // ── Reputation ───────────────────────────────────────────────────
  const { data: rated } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, store_rating, store_review, store_review_reply, created_at")
    .eq("store_id", store.id)
    .not("store_rating", "is", null)
    .order("created_at", { ascending: false })
    .limit(200);
  const customers = await usersById((rated ?? []).slice(0, 30).map((r) => r.customer_id));
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: (rated ?? []).filter((r) => r.store_rating === stars).length,
  }));
  const reputation = {
    rating: Number(store.rating) || 0,
    review_count: Number(store.review_count) || (rated ?? []).length,
    distribution,
    needs_reply: (rated ?? []).filter((r) => r.store_rating <= 3 && !r.store_review_reply).length,
    reviews: (rated ?? []).slice(0, 30).map((r) => ({
      order_id: r.id,
      customer_name: fullName(customers.get(r.customer_id)) ?? "Customer",
      rating: r.store_rating,
      review: r.store_review,
      reply: r.store_review_reply,
      created_at: r.created_at,
    })),
  };

  const potential = round2(Math.max(0, avgWeek * 0.12) + pricing.length * 150);

  return {
    store_id: store.id,
    summary: { open_actions: actions.length, potential_gain: potential },
    action_plan: actions,
    pricing,
    promotions,
    benchmark: { rank_percent, compared_stores: peers.length, metrics },
    missed_demand,
    weekly_goal: { goal, current: round2(weekRevenue), days, past_weeks },
    reputation,
    suggestions: suggestions ?? [],
  };
}

/**
 * Push the top strategy actions as "improvement" notifications (Efficiency
 * tab) — at most once per action per store per week.
 */
export async function generateImprovementNotifications(merchantId: string, store: StoreRow) {
  const strategy = await computeStrategy(merchantId, store);
  const week = weekStart().toISOString().slice(0, 10);
  const { data: sent } = await supabaseAdmin
    .from("notifications")
    .select("payload, notification_recipients!inner(user_id, role)")
    .eq("type", "improvement")
    .eq("notification_recipients.user_id", merchantId)
    .eq("notification_recipients.role", "merchant")
    .gte("created_at", new Date(Date.now() - 8 * DAY).toISOString());
  const seen = new Set(
    (sent ?? []).map((n: any) => `${n.payload?.store_id}:${n.payload?.action_id}:${n.payload?.week}`)
  );
  let created = 0;
  for (const a of strategy.action_plan.filter((x: any) => x.priority !== "low").slice(0, 3)) {
    const key = `${store.id}:${a.id}:${week}`;
    if (seen.has(key)) continue;
    await createNotification({
      userId: merchantId,
      role: "merchant",
      type: "improvement",
      title: a.title,
      description: `${store.name}: ${a.detail}`,
      payload: {
        kind: "improvement",
        action_id: a.id,
        action_kind: a.kind,
        store_id: store.id,
        store_name: store.name,
        impact: a.impact,
        product_ids: a.product_ids ?? [],
        week,
      },
      href: "/(merchant)/strategy",
      push: false,
    }).catch(() => null);
    created++;
  }
  return created;
}

/** All merchants' stores → improvement notifications (cron). */
export async function runMerchantInsights() {
  const { data: stores } = await supabaseAdmin
    .from("stores")
    .select("*")
    .eq("status", "active")
    .not("owner_id", "is", null);
  let created = 0;
  for (const s of (stores ?? []) as StoreRow[]) {
    created += await generateImprovementNotifications(s.owner_id!, s).catch(() => 0);
  }
  return { stores: stores?.length ?? 0, created };
}

export { LOW_STOCK };
