import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { earningsQuerySchema, MerchantEarningsResponse } from "../../validators/merchant";
import {
  orderRef,
  orderSale,
  ownedStores,
  periodRange,
  round2,
  storeOrders,
  snapshotRate,
  storeRatesFor,
} from "./shared";

const app = router();

// ─── Merchant: earnings for a period (all stores or one) ─────────────
// gross = delivered goods subtotal − customer discounts; commissions/taxes =
// Blink commission + stamp duty on gross sales; net = gross − commissions.
const route = createRoute({
  method: "get",
  path: "/earnings",
  operationId: "getMerchantEarnings",
  tags: ["merchant"],
  security: bearer,
  request: { query: earningsQuerySchema },
  responses: {
    200: json(MerchantEarningsResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

const PENDING = new Set(["searching", "heading_to_store", "preparation", "pickup", "on_the_way"]);

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { period, from, to, store_id } = c.req.valid("query");
  const range = periodRange(period, from, to);

  const stores = (await ownedStores(user.id)).filter((s) => !store_id || s.id === store_id);
  const names = new Map(stores.map((s) => [s.id, s.name]));
  const orders = await storeOrders([...names.keys()], range.start, range.end);
  const current = new Map(await Promise.all(stores.map(async (s) => [s.id, await storeRatesFor(s)] as const)));

  let grossSales = 0;
  let commissionRaw = 0;
  let stampRaw = 0;
  let discounts = 0;
  let salesCount = 0;
  const operations: any[] = [];

  for (const o of orders) {
    const base = {
      reference: orderRef(o.id),
      store_id: o.store_id,
      store_name: names.get(o.store_id) ?? null,
      created_at: o.created_at,
    };
    if (o.status === "delivered") {
      grossSales += orderSale(o);
      // Each order at the rates it was placed under (a null snapshot: the store's current rate).
      const fallback = current.get(o.store_id);
      commissionRaw += orderSale(o) * snapshotRate(o.merchant_commission_rate, fallback?.commission ?? 0);
      stampRaw += orderSale(o) * snapshotRate(o.stamp_duty_rate, fallback?.stamp ?? 0);
      discounts += o.discount;
      salesCount += 1;
      operations.push({ ...base, id: o.id, type: "sale", amount: orderSale(o), status: "completed" });
    } else if (PENDING.has(o.status) && o.merchant_status !== "pending") {
      operations.push({ ...base, id: o.id, type: "sale", amount: orderSale(o), status: "pending" });
    } else if (o.status === "canceled" && o.merchant_status && o.merchant_status !== "pending") {
      // Canceled after the merchant accepted it — shows as a refund.
      operations.push({ ...base, id: o.id, type: "refund", amount: -orderSale(o), status: "cancelled" });
    }
  }

  let paymentsQ = supabaseAdmin
    .from("merchant_dues_payments")
    .select("*")
    .eq("merchant_id", user.id)
    .gte("created_at", range.start.toISOString())
    .lt("created_at", range.end.toISOString());
  if (store_id) paymentsQ = paymentsQ.eq("store_id", store_id);
  const { data: payments } = await paymentsQ;

  for (const p of payments ?? []) {
    operations.push({
      id: p.id,
      type: "dues",
      reference: null,
      store_id: p.store_id,
      store_name: p.store_id ? names.get(p.store_id) ?? null : null,
      created_at: p.created_at,
      amount: -Number(p.amount),
      status: p.status === "cancelled" ? "cancelled" : p.status === "pending" ? "pending" : "completed",
    });
  }
  operations.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const gross = round2(grossSales - discounts);
  const commission = round2(commissionRaw);
  const stamp = round2(stampRaw);
  const taxes = round2(commission + stamp);

  return c.json(
    {
      net_income: round2(gross - taxes),
      sales_count: salesCount,
      gross_income: {
        total: gross,
        details: [
          { key: "gross_sales", amount: round2(grossSales) },
          { key: "discounts", amount: -round2(discounts) },
        ],
      },
      commissions_taxes: {
        total: taxes,
        details: [
          { key: "blink_commissions", amount: commission },
          { key: "tax_stamp", amount: stamp },
        ],
      },
      operations,
    },
    200
  );
});

export default app;
