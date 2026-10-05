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
  const { page, limit, status } = query;
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

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json(
    {
      orders: data,
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
