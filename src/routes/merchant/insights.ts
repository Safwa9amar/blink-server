// Builds the merchant dashboard tabs (current store + global comparison) from
// real orders. The output matches the app's DashTab / GlobalTab models
// (blink/store/merchant/merchant-dashboard-store.ts). Commentary is rule-based
// English copy, the same strings the app showed as mock data before.
import type { Range, StoreOrder } from "./shared";
import { orderSale, round2 } from "./shared";

type DashPeriod = "today" | "this_week" | "this_month" | "this_year";
type Cta =
  | "create_promo"
  | "set_hours"
  | "build_pack"
  | "reply"
  | "view_playbook"
  | "boost_store"
  | "open_reviews";

const PERIOD_LABEL: Record<DashPeriod, string> = {
  today: "TODAY",
  this_week: "THIS WEEK",
  this_month: "THIS MONTH",
  this_year: "THIS YEAR",
};
const PREV_LABEL: Record<DashPeriod, string> = {
  today: "yesterday",
  this_week: "last week",
  this_month: "last month",
  this_year: "last year",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Formatting ──────────────────────────────────────────────────────

export function fmtK(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${round2(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${Math.round(n)}`;
}
const money = (n: number) => `${fmtK(n)} Da`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

function delta(cur: number, prev: number): { delta?: string; deltaDir?: "up" | "down" } {
  if (prev <= 0) return {};
  const change = Math.round(((cur - prev) / prev) * 100);
  return { delta: `${Math.abs(change)}%`, deltaDir: change >= 0 ? "up" : "down" };
}

// ─── Buckets ─────────────────────────────────────────────────────────

interface Buckets {
  count: number;
  label: (i: number) => string;
  index: (d: Date, start: Date) => number;
  unit: string; // for copy: "day", "week", …
}

function buckets(period: DashPeriod, start: Date): Buckets {
  switch (period) {
    case "today":
      return {
        count: 8,
        label: (i) => `${i * 3}h`,
        index: (d, s) => Math.floor((d.getTime() - s.getTime()) / (3 * 60 * 60 * 1000)),
        unit: "time slot",
      };
    case "this_week":
      return {
        count: 7,
        label: (i) => DAY_NAMES[(start.getDay() + i) % 7],
        index: (d, s) => Math.floor((d.getTime() - s.getTime()) / DAY_MS),
        unit: "day",
      };
    case "this_month":
      return {
        count: 5,
        label: (i) => `W${i + 1}`,
        index: (d, s) => Math.floor((d.getTime() - s.getTime()) / (7 * DAY_MS)),
        unit: "week",
      };
    case "this_year":
      return {
        count: 12,
        label: (i) => MONTHS[i],
        index: (d, s) =>
          (d.getFullYear() - s.getFullYear()) * 12 + d.getMonth() - s.getMonth(),
        unit: "month",
      };
  }
}

function series(orders: StoreOrder[], b: Buckets, start: Date, value: (o: StoreOrder) => number) {
  const out = new Array(b.count).fill(0);
  for (const o of orders) {
    const i = b.index(new Date(o.created_at), start);
    if (i >= 0 && i < b.count) out[i] += value(o);
  }
  return out as number[];
}

/** Indices of the top-2 non-zero values (highlighted bars). */
function topTwo(values: number[]): Set<number> {
  return new Set(
    values
      .map((v, i) => [v, i] as const)
      .filter(([v]) => v > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 2)
      .map(([, i]) => i)
  );
}

const delivered = (orders: StoreOrder[]) => orders.filter((o) => o.status === "delivered");
const placed = (orders: StoreOrder[]) =>
  orders.filter((o) => o.status !== "merchant_rejected" && o.merchant_status !== "rejected");

function insight(heading: string, bullets: string[], text: string, cta: Cta) {
  return { heading, bullets, recommendation: { text, cta } };
}

// ─── Current store ───────────────────────────────────────────────────

export interface StoreContext {
  store: { name: string; rating: number; review_count: number };
  products: { title: string; photos: string[] | null; image: string; is_available: boolean }[];
  packs: { name: string; status: string }[];
}

export function buildStoreTabs(
  period: DashPeriod,
  range: Range,
  cur: StoreOrder[],
  prev: StoreOrder[],
  ctx: StoreContext
) {
  const P = PERIOD_LABEL[period];
  const vsPrev = PREV_LABEL[period];
  const b = buckets(period, range.start);
  const dCur = delivered(cur);
  const dPrev = delivered(prev);

  // ── Revenue
  const revenue = dCur.reduce((s, o) => s + orderSale(o), 0);
  const prevRevenue = dPrev.reduce((s, o) => s + orderSale(o), 0);
  const revSeries = series(dCur, b, range.start, orderSale);
  const prevRevSeries = series(dPrev, b, range.prevStart, orderSale);
  const revTop = topTwo(revSeries);
  const bestIdx = revSeries.indexOf(Math.max(...revSeries));
  const growing = revenue >= prevRevenue;
  const diff = revenue - prevRevenue;

  const revenueTab = {
    key: "revenue" as const,
    headline: {
      label: `NET REVENUE · ${P}`,
      value: money(revenue),
      ...delta(revenue, prevRevenue),
      sub: `${diff >= 0 ? "+" : "−"}${fmtK(Math.abs(diff))} vs ${vsPrev}`,
    },
    chartTitle: `Revenue by ${b.unit}`,
    chartType: "vbars" as const,
    vbars: revSeries.map((v, i) => ({
      label: b.label(i),
      value: round2(v / 1000),
      ...(revTop.has(i) ? { highlight: true } : {}),
    })),
    aiComment:
      revenue === 0
        ? "No delivered orders yet in this period. Make sure your products are available and priced so customers can order."
        : `${b.label(bestIdx)} was your best ${b.unit} with ${money(revSeries[bestIdx])} (${pct(revSeries[bestIdx], revenue)}% of revenue). Revenue is ${growing ? "up" : "down"} ${fmtK(Math.abs(diff))} vs ${vsPrev}.`,
    table: {
      columns: [
        { key: b.unit === "time slot" ? "hour" : "day", align: "left" as const },
        { key: "revenue", align: "right" as const },
        { key: "vs_prev", align: "right" as const },
      ],
      rows: revSeries.map((v, i) => {
        const p = prevRevSeries[i];
        const change = p > 0 ? `${v >= p ? "+" : "−"}${Math.abs(Math.round(((v - p) / p) * 100))}%` : "—";
        return [b.label(i), fmtK(v), change];
      }),
    },
    insight: insight(
      "Why it changed",
      revenue === 0
        ? ["No sales recorded in this period yet."]
        : [
            prevRevenue > 0
              ? `Revenue ${growing ? "grew" : "fell"} ${delta(revenue, prevRevenue).delta} vs ${vsPrev}.`
              : `First sales compared with ${vsPrev}.`,
            `${b.label(bestIdx)} is your strongest ${b.unit}.`,
          ],
      growing ? "Launch a bundle to ride the upward trend." : "Run a promo to win customers back.",
      growing ? "build_pack" : "create_promo"
    ),
  };

  // ── Orders
  const pCur = placed(cur);
  const pPrev = placed(prev);
  const ordSeries = series(pCur, b, range.start, () => 1);
  const ordTop = topTwo(ordSeries);
  const canceled = cur.filter((o) => o.status === "canceled").length;
  const rejected = cur.filter((o) => o.merchant_status === "rejected").length;
  const fulfilled = pct(dCur.length, Math.max(pCur.length, 1));
  const aov = dCur.length ? revenue / dCur.length : 0;

  const ordersTab = {
    key: "orders" as const,
    headline: {
      label: `ORDERS · ${P}`,
      value: int(pCur.length),
      ...delta(pCur.length, pPrev.length),
      sub: `${fulfilled}% delivered · avg basket ${money(aov)}`,
    },
    chartTitle: `Orders by ${b.unit}`,
    chartType: "vbars" as const,
    vbars: ordSeries.map((v, i) => ({
      label: b.label(i),
      value: v,
      ...(ordTop.has(i) ? { highlight: true } : {}),
    })),
    aiComment:
      pCur.length === 0
        ? "No orders yet in this period."
        : `${int(pCur.length)} orders, ${dCur.length} delivered. ${rejected > 0 ? `You declined ${rejected} — every declined order is a lost customer.` : "You haven't declined any orders — great reliability."}`,
    table: {
      columns: [
        { key: b.unit === "time slot" ? "hour" : "day", align: "left" as const },
        { key: "orders", align: "right" as const },
        { key: "share", align: "right" as const },
      ],
      rows: ordSeries.map((v, i) => [b.label(i), int(v), `${pct(v, pCur.length)}%`]),
    },
    insight: insight(
      "Fulfillment health",
      [
        `${fulfilled}% of orders delivered so far.`,
        `Cancellations: ${canceled} · declined by you: ${rejected}.`,
      ],
      rejected > 0
        ? "Review your opening hours so you only receive orders you can serve."
        : "Keep your hours up to date to stay reliable.",
      "set_hours"
    ),
  };

  // ── Products (by revenue from order items; pack lines are Bundles)
  const byProduct = new Map<string, { units: number; revenue: number }>();
  for (const o of dCur) {
    for (const it of o.items ?? []) {
      if (it.pack_id) continue;
      const p = byProduct.get(it.name) ?? { units: 0, revenue: 0 };
      p.units += it.quantity;
      p.revenue += it.quantity * it.unit_price;
      byProduct.set(it.name, p);
    }
  }
  const ranked = [...byProduct.entries()].sort((a, b) => b[1].revenue - a[1].revenue);
  const top = ranked.slice(0, 5);
  const itemsRevenue = ranked.reduce((s, [, p]) => s + p.revenue, 0);
  const topShare = pct(top.slice(0, 4).reduce((s, [, p]) => s + p.revenue, 0), itemsRevenue);
  const noPhoto = ctx.products.filter((p) => !(p.photos?.length || p.image)).length;
  const unavailable = ctx.products.filter((p) => !p.is_available).length;

  const productsTab = {
    key: "products" as const,
    headline: {
      label: `PRODUCTS · ${P}`,
      value: top[0]?.[0] ?? "—",
      sub: top[0]
        ? `Top seller · ${money(top[0][1].revenue)}, ${pct(top[0][1].revenue, itemsRevenue)}% of revenue`
        : `${ctx.products.length} products listed`,
    },
    chartTitle: "Top products by revenue",
    chartType: "hbars" as const,
    hbars: top.map(([name, p]) => ({
      label: name,
      value: round2(p.revenue / 1000),
      display: money(p.revenue),
    })),
    aiComment: top[0]
      ? `${top[0][0]} leads your sales. Your top ${Math.min(4, top.length)} products make up ${topShare}% of revenue.`
      : "No product sales yet in this period.",
    table: {
      columns: [
        { key: "product", align: "left" as const },
        { key: "units", align: "right" as const },
        { key: "revenue", align: "right" as const },
        { key: "share", align: "right" as const },
      ],
      rows: top.map(([name, p]) => [
        name,
        int(p.units),
        fmtK(p.revenue),
        `${pct(p.revenue, itemsRevenue)}%`,
      ]),
    },
    insight: insight(
      "Product mix",
      [
        noPhoto > 0
          ? `${noPhoto} product${noPhoto > 1 ? "s have" : " has"} no photo, hurting discovery.`
          : "Every product has a photo.",
        unavailable > 0
          ? `${unavailable} product${unavailable > 1 ? "s are" : " is"} marked unavailable.`
          : `${ctx.products.length} products are live.`,
      ],
      top[0] ? `Bundle ${top[0][0]} with complementary items.` : "Build a pack to feature your catalog.",
      "build_pack"
    ),
  };

  // ── Hours (orders by hour of day, 2h slots 8h–22h)
  const slots = [8, 10, 12, 14, 16, 18, 20, 22];
  const bySlot = slots.map(() => 0);
  for (const o of pCur) {
    const h = new Date(o.created_at).getHours();
    const i = slots.findIndex((s, k) => h >= s && (k === slots.length - 1 || h < slots[k + 1]));
    if (i >= 0) bySlot[i] += 1;
  }
  const slotTop = topTwo(bySlot);
  const peak = bySlot.indexOf(Math.max(...bySlot));
  const peakLabel = `${String(slots[peak]).padStart(2, "0")}:00–${String(Math.min(slots[peak] + 2, 24)).padStart(2, "0")}:00`;

  const hoursTab = {
    key: "hours" as const,
    headline: {
      label: `SALES BY HOUR · ${P}`,
      value: pCur.length ? peakLabel : "—",
      sub: pCur.length
        ? `Your peak window · ${pct(bySlot[peak], pCur.length)}% of orders`
        : "No orders yet in this period",
    },
    chartTitle: "Orders by hour",
    chartType: "vbars" as const,
    vbars: slots.map((s, i) => ({
      label: `${s}h`,
      value: bySlot[i],
      ...(slotTop.has(i) ? { highlight: true } : {}),
    })),
    aiComment: pCur.length
      ? `The ${peakLabel} window is your busiest. Make sure stock and staff are ready before it hits.`
      : "Once orders come in, you'll see your busiest hours here.",
    table: {
      columns: [
        { key: "hour", align: "left" as const },
        { key: "orders", align: "right" as const },
        { key: "share", align: "right" as const },
      ],
      rows: slots.map((s, i) => [
        `${String(s).padStart(2, "0")}:00`,
        int(bySlot[i]),
        `${pct(bySlot[i], pCur.length)}%`,
      ]),
    },
    insight: insight(
      "Timing patterns",
      pCur.length
        ? [`Peak: ${peakLabel}.`, "Quiet slots are a good time to restock."]
        : ["Not enough orders to spot a pattern yet."],
      "Match your opening hours to when customers order.",
      "set_hours"
    ),
  };

  // ── Ratings (customer ratings on orders)
  const rated = cur.filter((o) => o.store_rating);
  const prevRated = prev.filter((o) => o.store_rating);
  const avg = (os: StoreOrder[]) =>
    os.length ? os.reduce((s, o) => s + (o.store_rating ?? 0), 0) / os.length : 0;
  const avgCur = rated.length ? avg(rated) : ctx.store.rating;
  const avgPrev = avg(prevRated);
  const dist = [5, 4, 3, 2, 1].map((star) => rated.filter((o) => o.store_rating === star).length);
  const highShare = pct(dist[0] + dist[1], rated.length);
  const lowCount = dist[3] + dist[4];

  const ratingsTab = {
    key: "ratings" as const,
    headline: {
      label: `CUSTOMER RATING · ${P}`,
      value: avgCur ? `${avgCur.toFixed(1)} ★` : "—",
      sub: rated.length
        ? `${rated.length} ratings${avgPrev ? ` · ${avgCur >= avgPrev ? "▲" : "▼"} ${Math.abs(avgCur - avgPrev).toFixed(1)} vs ${vsPrev}` : ""}`
        : `${ctx.store.review_count} ratings all-time`,
    },
    chartTitle: "Rating distribution",
    chartType: "hbars" as const,
    hbars: dist.map((n, i) => ({ label: `${5 - i} ★`, value: n, display: int(n) })),
    aiComment: rated.length
      ? `${avgCur.toFixed(1)}★ from ${rated.length} ratings this period. ${lowCount > 0 ? `${lowCount} low rating${lowCount > 1 ? "s" : ""} — check what went wrong on those orders.` : "No low ratings — keep it up."}`
      : "No ratings in this period yet.",
    table: {
      columns: [
        { key: "stars", align: "left" as const },
        { key: "count", align: "right" as const },
        { key: "share", align: "right" as const },
      ],
      rows: dist.map((n, i) => [`${5 - i} ★`, int(n), `${pct(n, rated.length)}%`]),
    },
    insight: insight(
      "Review themes",
      rated.length
        ? [`${highShare}% of ratings are 4★ or higher.`, `${lowCount} rating${lowCount === 1 ? "" : "s"} at 2★ or below.`]
        : ["Ratings appear after customers rate delivered orders."],
      lowCount > 0 ? "Open the low-rated orders and look for patterns." : "Keep packing quality consistent.",
      "open_reviews"
    ),
  };

  // ── Bundles (pack lines: order items with a pack_id), grouped per pack and
  // labelled with its newest name (dCur is newest first).
  const activePacks = ctx.packs.filter((p) => p.status === "active").length;
  const byPackId = new Map<string, { name: string; units: number; revenue: number }>();
  let ordersWithPack = 0;
  for (const o of dCur) {
    let has = false;
    for (const it of o.items ?? []) {
      if (!it.pack_id) continue;
      has = true;
      const p = byPackId.get(it.pack_id) ?? { name: it.name, units: 0, revenue: 0 };
      p.units += it.quantity;
      p.revenue += it.quantity * it.unit_price;
      byPackId.set(it.pack_id, p);
    }
    if (has) ordersWithPack += 1;
  }
  const packRanked = [...byPackId.values()]
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)
    .map((p) => [p.name, p] as const);
  const bundleRevenue = [...byPackId.values()].reduce((s, p) => s + p.revenue, 0);
  const withPackOrders = dCur.filter((o) => (o.items ?? []).some((it) => !!it.pack_id));
  const withoutPackOrders = dCur.filter((o) => !withPackOrders.includes(o));
  const aovWith = withPackOrders.length
    ? withPackOrders.reduce((s, o) => s + orderSale(o), 0) / withPackOrders.length
    : 0;
  const aovWithout = withoutPackOrders.length
    ? withoutPackOrders.reduce((s, o) => s + orderSale(o), 0) / withoutPackOrders.length
    : 0;
  const uplift = aovWithout > 0 && aovWith > 0 ? Math.round(((aovWith - aovWithout) / aovWithout) * 100) : 0;

  const bundlesTab = {
    key: "bundles" as const,
    headline: {
      label: `BUNDLE REVENUE SHARE · ${P}`,
      value: `${pct(bundleRevenue, revenue)}%`,
      sub: `Bundles brought in ${money(bundleRevenue)}`,
    },
    miniStats: [
      { key: "attach_rate", value: `${pct(ordersWithPack, dCur.length)}%` },
      { key: "active_packs", value: `${activePacks}` },
      { key: "aov_uplift", value: `${uplift >= 0 ? "+" : ""}${uplift}%` },
    ],
    chartTitle: "Top bundles by revenue",
    chartType: "hbars" as const,
    hbars: packRanked.map(([name, p]) => ({
      label: name,
      value: round2(p.revenue / 1000),
      display: money(p.revenue),
    })),
    aiComment: packRanked[0]
      ? `${packRanked[0][0]} is ${pct(packRanked[0][1].revenue, bundleRevenue)}% of bundle sales — feature it on your storefront.`
      : activePacks
        ? `You have ${activePacks} active pack${activePacks > 1 ? "s" : ""} but no bundle sales yet in this period.`
        : "You don't have any active packs yet — bundles raise basket value.",
    table: {
      columns: [
        { key: "bundle", align: "left" as const },
        { key: "units", align: "right" as const },
        { key: "revenue", align: "right" as const },
        { key: "share", align: "right" as const },
      ],
      rows: packRanked.map(([name, p]) => [
        name,
        int(p.units),
        fmtK(p.revenue),
        `${pct(p.revenue, bundleRevenue)}%`,
      ]),
    },
    insight: insight(
      "Bundle performance",
      [
        `${activePacks} active pack${activePacks === 1 ? "" : "s"}.`,
        `${pct(ordersWithPack, dCur.length)}% of delivered orders included a bundle.`,
      ],
      activePacks ? "Create another bundle around your top seller." : "Create your first bundle.",
      "build_pack"
    ),
  };

  return [revenueTab, ordersTab, productsTab, hoursTab, ratingsTab, bundlesTab];
}

// ─── Global (all stores) ─────────────────────────────────────────────

export interface GlobalStoreStat {
  id: string;
  name: string;
  revenue: number; // Da
  prevRevenue: number;
  orders: number;
  prevOrders: number;
  rating: number;
  bundle: number; // Da
}

const short = (name: string) => name.split(/[—-]/).pop()!.trim() || name;

export function buildGlobalTabs(period: DashPeriod, stats: GlobalStoreStat[]) {
  const P = PERIOD_LABEL[period];
  const n = stats.length;
  const sum = (f: (s: GlobalStoreStat) => number) => stats.reduce((t, s) => t + f(s), 0);
  const revenue = sum((s) => s.revenue);
  const prevRevenue = sum((s) => s.prevRevenue);
  const orders = sum((s) => s.orders);
  const prevOrders = sum((s) => s.prevOrders);
  const rated = stats.filter((s) => s.rating > 0);
  const avgRating = rated.length ? rated.reduce((t, s) => t + s.rating, 0) / rated.length : 0;
  const bundle = sum((s) => s.bundle);

  const by = (f: (s: GlobalStoreStat) => number) => [...stats].sort((a, b) => f(b) - f(a));
  const byRev = by((s) => s.revenue);
  const byOrders = by((s) => s.orders);
  const byRating = by((s) => s.rating);
  const byBundle = by((s) => s.bundle);
  const topRev = byRev[0];
  const lastRev = byRev[n - 1];
  const top2Share = pct((byRev[0]?.revenue ?? 0) + (byRev[1]?.revenue ?? 0), revenue);
  const gap = topRev && lastRev && topRev.revenue > 0 ? pct(topRev.revenue - lastRev.revenue, topRev.revenue) : 0;

  const tabs = [
    {
      key: "overview" as const,
      headline: {
        label: `NETWORK · ${P}`,
        value: money(revenue),
        ...delta(revenue, prevRevenue),
        sub: `${n} store${n === 1 ? "" : "s"} · ${int(orders)} orders${avgRating ? ` · ★ ${avgRating.toFixed(1)} avg` : ""}`,
      },
      leaderboardTitle: "Store leaderboard — revenue",
      metric: "revenue" as const,
      aiComment:
        n < 2
          ? "Add more stores to compare performance across locations."
          : `${short(byRev[0].name)} and ${short(byRev[1].name)} make up ${top2Share}% of network revenue.`,
      insight: insight(
        "Network read",
        n < 2
          ? ["Only one store in your network so far."]
          : [
              `Your top 2 stores drive ${top2Share}% of revenue.`,
              `${short(lastRev.name)} trails on revenue.`,
            ],
        n < 2 ? "Open a new store to grow your network." : `Run a local promo for ${short(lastRev.name)}.`,
        "create_promo"
      ),
      tableMode: "comparison" as const,
    },
    {
      key: "revenue" as const,
      headline: {
        label: "TOP STORE · REVENUE",
        value: topRev ? short(topRev.name) : "—",
        sub: topRev ? `${money(topRev.revenue)} · ${pct(topRev.revenue, revenue)}% of network revenue` : "No stores yet",
      },
      leaderboardTitle: "Revenue by store",
      metric: "revenue" as const,
      aiComment:
        n < 2
          ? "Revenue comparison needs at least two stores."
          : `${short(topRev.name)} leads; ${short(lastRev.name)} is ${gap}% behind the top store.`,
      insight: insight(
        "Where revenue concentrates",
        n < 2 ? ["Single-store network."] : [`Top store: ${short(topRev.name)}.`, `Gap to the weakest store: ${gap}%.`],
        n < 2 ? "Keep growing your flagship." : `Replicate ${short(topRev.name)}'s catalog at ${short(lastRev.name)}.`,
        "view_playbook"
      ),
      tableMode: "single" as const,
    },
    {
      key: "orders" as const,
      headline: {
        label: `TOTAL ORDERS · ${P}`,
        value: int(orders),
        ...delta(orders, prevOrders),
        sub: byOrders[0] ? `${short(byOrders[0].name)} leads at ${int(byOrders[0].orders)} orders` : "No orders yet",
      },
      leaderboardTitle: "Orders by store",
      metric: "orders" as const,
      aiComment: orders ? "Order volume tracks revenue closely across your stores." : "No orders yet in this period.",
      insight: insight(
        "Volume read",
        byOrders[n - 1] && n > 1
          ? [`${short(byOrders[n - 1].name)} has the lowest volume.`, "Visibility drives volume."]
          : ["Not enough stores to compare volume."],
        "Boost your lowest-volume store's visibility.",
        "boost_store"
      ),
      tableMode: "single" as const,
    },
    {
      key: "ratings" as const,
      headline: {
        label: "AVG RATING · NETWORK",
        value: avgRating ? `${avgRating.toFixed(1)} ★` : "—",
        sub: byRating[0]?.rating
          ? `${short(byRating[0].name)} best at ${byRating[0].rating.toFixed(1)}`
          : "No ratings yet",
      },
      leaderboardTitle: "Ratings by store",
      metric: "rating" as const,
      aiComment: byRating[0]?.rating
        ? `${short(byRating[0].name)} has the happiest customers.`
        : "Ratings appear once customers rate delivered orders.",
      insight: insight(
        "Service read",
        byRating[0]?.rating ? [`${short(byRating[0].name)}'s service is the benchmark.`] : ["No ratings yet."],
        "Review feedback on your lowest-rated store.",
        "open_reviews"
      ),
      tableMode: "single" as const,
    },
    {
      key: "bundles" as const,
      headline: {
        label: "BUNDLE REVENUE · NETWORK",
        value: money(bundle),
        sub: byBundle[0]?.bundle ? `${short(byBundle[0].name)} earns the most from bundles` : "No bundle sales yet",
      },
      leaderboardTitle: "Bundle revenue by store",
      metric: "bundle" as const,
      aiComment: bundle
        ? `Bundles are ${pct(bundle, revenue)}% of network revenue.`
        : "No bundle sales yet — packs raise basket value.",
      insight: insight(
        "Bundle read",
        [`Bundles are ${pct(bundle, revenue)}% of revenue.`],
        "Roll out your best bundle to every store.",
        "build_pack"
      ),
      tableMode: "single" as const,
    },
  ];

  const rows = stats.map((s) => ({
    id: s.id,
    name: s.name,
    revenue: round2(s.revenue / 1000),
    orders: s.orders,
    rating: round2(s.rating),
    bundle: round2(s.bundle / 1000),
  }));

  return { tabs, stores: rows };
}
