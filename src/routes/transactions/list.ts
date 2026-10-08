import { supabaseAdmin } from "../../lib/supabase";
import { withRiders } from "../../lib/transactions";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { listTransactionsSchema, TransactionListResponse } from "../../validators/transactions";

const app = router();

// ─── List transactions ───────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listTransactions",
  tags: ["transactions"],
  security: bearer,
  request: { query: listTransactionsSchema },
  responses: { 200: json(TransactionListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const query = c.req.valid("query");
  const { page, limit, type, status } = query;
  const offset = (page - 1) * limit;

  // Agents see transactions they processed; riders see their own
  const column = user.role === "agent" ? "agent_id" : "user_id";

  let q = supabaseAdmin
    .from("transactions")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (type) q = q.eq("type", type);
  if (status) q = q.eq("status", status);

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // Agents get the rider's identity embedded on each row.
  const transactions = user.role === "agent" ? await withRiders(data ?? []) : data ?? [];

  return c.json(
    {
      transactions,
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
