import { isCourierSearchExpired } from "../../lib/courier";
import { expireCourierOrder } from "../../lib/courier-timeouts";
import { isActiveOrder, isLiveOrder } from "../../lib/rider-card";
import { attachRiders, attachStoreInfo } from "../../lib/rider-cards-load";
import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listOrdersSchema, OrderListResponse } from "../../validators/orders";

const app = router();

// ─── List orders ─────────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listOrders",
  tags: ["orders"],
  security: bearer,
  request: { query: listOrdersSchema },
  responses: { 200: json(OrderListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const { page, limit, status, checkout_id, courier_group_id } = query;
  const offset = (page - 1) * limit;

  const column =
    user.role === "customer"
      ? "customer_id"
      : user.role === "rider"
        ? "rider_id"
        : "customer_id";

  let q = supabaseAdmin
    .from("orders")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) q = q.eq("status", status);
  // Sibling orders of one multi-store checkout — still scoped to the caller above.
  if (checkout_id) q = q.eq("checkout_id", checkout_id);
  // The routes of one courier request — scoped to the caller too.
  if (courier_group_id) q = q.eq("courier_group_id", courier_group_id);

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // A courier request no rider took is canceled as soon as anyone looks, so
  // the list never shows it searching past its window (the cron does the rest).
  const now = Date.now();
  const rows = await Promise.all(
    (data ?? []).map(async (o) => (isCourierSearchExpired(o, now) ? ((await expireCourierOrder(o, now)) ?? o) : o))
  );

  // Which rider a store asked is the merchant's business only.
  let orders = rows.map((o) => withoutOffer(o));
  if (column === "customer_id") {
    // The caller's own orders: who delivers them + the store card.
    orders = await attachStoreInfo(await attachRiders(orders, isActiveOrder, isLiveOrder));
  }

  return c.json(
    {
      orders,
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
