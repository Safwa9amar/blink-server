import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  dashboardQuerySchema,
  MerchantGlobalDashboardResponse,
} from "../../validators/merchant";
import { buildGlobalTabs, type GlobalStoreStat } from "./insights";
import { orderSale, ownedStores, periodRange, storeOrders } from "./shared";

const app = router();

// ─── Merchant: global dashboard (all own stores compared) ────────────
const route = createRoute({
  method: "get",
  path: "/dashboard/global",
  operationId: "getMerchantGlobalDashboard",
  tags: ["merchant"],
  security: bearer,
  request: { query: dashboardQuerySchema.pick({ period: true }) },
  responses: {
    200: json(MerchantGlobalDashboardResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { period } = c.req.valid("query");
  const range = periodRange(period);

  const stores = await ownedStores(user.id);
  const ids = stores.map((s) => s.id);
  const [orders, { data: packs }] = await Promise.all([
    storeOrders(ids, range.prevStart, range.end),
    ids.length
      ? supabaseAdmin.from("store_packs").select("store_id, name").in("store_id", ids)
      : Promise.resolve({ data: [] as { store_id: string; name: string }[] }),
  ]);

  const stats: GlobalStoreStat[] = stores.map((s) => {
    const packNames = new Set((packs ?? []).filter((p) => p.store_id === s.id).map((p) => p.name));
    const mine = orders.filter((o) => o.store_id === s.id);
    const cur = mine.filter((o) => new Date(o.created_at) >= range.start);
    const prev = mine.filter((o) => new Date(o.created_at) < range.start);
    const delivered = cur.filter((o) => o.status === "delivered");
    const rated = cur.filter((o) => o.store_rating);
    return {
      id: s.id,
      name: s.name,
      revenue: delivered.reduce((t, o) => t + orderSale(o), 0),
      prevRevenue: prev
        .filter((o) => o.status === "delivered")
        .reduce((t, o) => t + orderSale(o), 0),
      orders: cur.filter((o) => o.status !== "merchant_rejected").length,
      prevOrders: prev.filter((o) => o.status !== "merchant_rejected").length,
      rating: rated.length
        ? rated.reduce((t, o) => t + (o.store_rating ?? 0), 0) / rated.length
        : Number(s.rating) || 0,
      bundle: delivered.reduce(
        (t, o) =>
          t +
          (o.items ?? [])
            .filter((it) => packNames.has(it.name))
            .reduce((x, it) => x + it.quantity * it.unit_price, 0),
        0
      ),
    };
  });

  return c.json(buildGlobalTabs(period, stats), 200);
});

export default app;
