import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { dashboardQuerySchema, MerchantDashboardResponse } from "../../validators/merchant";
import { buildStoreTabs } from "./insights";
import { ownedStore, ownedStores, periodRange, storeOrders } from "./shared";

const app = router();

// ─── Merchant: current-store dashboard (KPI tabs + insights) ─────────
const route = createRoute({
  method: "get",
  path: "/dashboard",
  operationId: "getMerchantDashboard",
  tags: ["merchant"],
  security: bearer,
  request: { query: dashboardQuerySchema },
  responses: {
    200: json(MerchantDashboardResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { store_id, period } = c.req.valid("query");

  const store = store_id
    ? await ownedStore(user.id, store_id)
    : (await ownedStores(user.id))[0] ?? null;
  if (!store) return c.json({ error: "Store not found" }, 404);

  const range = periodRange(period);
  const [orders, { data: products }, { data: packs }] = await Promise.all([
    storeOrders([store.id], range.prevStart, range.end),
    supabaseAdmin
      .from("store_products")
      .select("title, photos, image, is_available")
      .eq("store_id", store.id),
    supabaseAdmin.from("store_packs").select("name, status").eq("store_id", store.id),
  ]);

  const cur = orders.filter((o) => new Date(o.created_at) >= range.start);
  const prev = orders.filter((o) => new Date(o.created_at) < range.start);

  const tabs = buildStoreTabs(period, range, cur, prev, {
    store: {
      name: store.name,
      rating: Number(store.rating) || 0,
      review_count: Number(store.review_count) || 0,
    },
    products: products ?? [],
    packs: packs ?? [],
  });

  return c.json({ tabs }, 200);
});

export default app;
