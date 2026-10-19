// Staff audit of product price changes across stores (who moved which price,
// when, through what). Tagged admin-* so it stays out of the mobile client
// (orval skips it); the dashboard calls it (super_admin / commerce_admin).
import { toPriceChange } from "../../lib/price-history";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AdminPriceChangeListResponse, listPriceChangesSchema } from "../../validators/merchant";

const app = router();

/** Same roles as the catalog review. */
const catalogStaff = requireStaffRole("commerce_admin");

const route = createRoute({
  method: "get",
  path: "/admin/price-changes",
  operationId: "listProductPriceChanges",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { query: listPriceChangesSchema },
  responses: {
    200: json(AdminPriceChangeListResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const { page, limit, store_id, product_id, source, from, to } = c.req.valid("query");
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("store_product_price_changes")
    .select(
      "id, product_id, store_id, old_price, new_price, old_blink_price, new_blink_price, source, changed_by, changed_at, " +
        "product:store_products(title), store:stores(name), user:users!changed_by(id, first_name, last_name)",
      { count: "exact" }
    );
  if (store_id) query = query.eq("store_id", store_id);
  if (product_id) query = query.eq("product_id", product_id);
  if (source) query = query.eq("source", source);
  if (from) query = query.gte("changed_at", from);
  if (to) query = query.lt("changed_at", to);

  const { data, error, count } = await query
    .order("changed_at", { ascending: false })
    // `id` breaks ties so pages never overlap.
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);

  // A page past the end is an empty page, not an error.
  if (error?.code === "PGRST103") return c.json({ changes: [], pagination: { page, limit, total: 0 } }, 200);
  if (error) return c.json({ error: error.message }, 400);

  const changes = ((data ?? []) as any[]).map((r) => {
    const name = r.user ? [r.user.first_name, r.user.last_name].filter(Boolean).join(" ").trim() || null : null;
    return {
      ...toPriceChange(r),
      product_id: r.product_id as string,
      product_title: (r.product?.title as string | undefined) ?? null,
      store_id: r.store_id as string,
      store_name: (r.store?.name as string | undefined) ?? null,
      changed_by: r.changed_by ? { id: r.changed_by as string, name } : null,
    };
  });
  return c.json({ changes, pagination: { page, limit, total: count ?? 0 } }, 200);
});

export default app;
