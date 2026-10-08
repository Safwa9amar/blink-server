import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  listMerchantOrdersSchema,
  MerchantOrderListResponse,
} from "../../validators/merchant";
import { enrichOrders } from "./orders-shared";
import { ACTIVE_ORDER_STATUSES, ownedStores } from "./shared";

const app = router();

// ─── Merchant: orders placed with own stores ─────────────────────────
// scope=active: needs the merchant or is on its way; scope=history: closed,
// filterable by kind (simple | packs), status (completed | cancelled), dates.
const route = createRoute({
  method: "get",
  path: "/orders",
  operationId: "listMerchantOrders",
  tags: ["merchant"],
  security: bearer,
  request: { query: listMerchantOrdersSchema },
  responses: {
    200: json(MerchantOrderListResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { store_id, scope = "active", kind, status, from, to } = c.req.valid("query");

  const owned = (await ownedStores(user.id)).map((s) => s.id);
  const storeIds = store_id ? owned.filter((id) => id === store_id) : owned;
  if (storeIds.length === 0) return c.json({ orders: [] }, 200);

  let q = supabaseAdmin
    .from("orders")
    .select("*")
    .in("store_id", storeIds)
    .order("created_at", { ascending: false })
    .limit(200);

  if (scope === "active") {
    // NULL-safe: `neq` alone would drop orders with no merchant_status yet.
    q = q
      .in("status", [...ACTIVE_ORDER_STATUSES])
      .or("merchant_status.is.null,merchant_status.neq.rejected");
  } else if (scope === "history") {
    q =
      status === "completed"
        ? q.eq("status", "delivered")
        : status === "cancelled"
          ? q.in("status", ["canceled", "merchant_rejected"])
          : q.in("status", ["delivered", "canceled", "merchant_rejected"]);
  }
  if (from) q = q.gte("created_at", from);
  if (to) q = q.lt("created_at", to);

  const { data, error } = await q;
  if (error) return c.json({ error: error.message }, 400);

  let orders = await enrichOrders(data ?? []);
  if (kind) orders = orders.filter((o) => (kind === "packs" ? o.has_pack : !o.has_pack));
  return c.json({ orders }, 200);
});

export default app;
