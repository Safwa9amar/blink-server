// Staff view of the payment gateways (finance_admin; super_admin passes). Tagged
// admin-payments so orval skips it; the dashboard's Blink Cash -> Payments tab uses it.
import { env } from "../../config/env";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { webhookUrl } from "../../lib/payments/core";
import { allProviders } from "../../lib/payments/registry";
import { syncPayment } from "../../lib/payments/service";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router, z } from "../../openapi";
import {
  AdminPayment,
  AdminPaymentListQuery,
  AdminPaymentListResponse,
  AdminPaymentProvidersResponse,
} from "../../validators/payments";
import { nameOf, usersById } from "../blink-cash/admin-shared";
import { PaymentIdParam, toPayment } from "./shared";

const app = router();
const TAG = ["admin-payments"];
const staff = requireStaffRole("finance_admin");
app.use("/admin", auth);
app.use("/admin/*", auth);

type Row = Record<string, any>;

const toAdmin = (p: Row, name: string | null) => ({
  ...toPayment(p),
  // Staff see the checkout link only while pending, like the owner.
  user_id: p.user_id as string,
  user_name: name,
  provider_ref: (p.provider_ref ?? null) as string | null,
  last_synced_at: (p.last_synced_at ?? null) as string | null,
});

app.openapi(
  createRoute({
    method: "get",
    path: "/admin",
    operationId: "adminListPayments",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { query: AdminPaymentListQuery },
    responses: { 200: json(AdminPaymentListResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const q = c.req.valid("query");
    let query = supabaseAdmin.from("payments").select("*", { count: "exact" });
    if (q.status) query = query.eq("status", q.status);
    if (q.provider) query = query.eq("provider", q.provider);
    if (q.purpose) query = query.eq("purpose", q.purpose);
    if (q.user_id) query = query.eq("user_id", q.user_id);
    const from = (q.page - 1) * q.limit;
    const { data, count, error } = await query.order("created_at", { ascending: false }).range(from, from + q.limit - 1);
    if (error) throw new Error(`[payments-admin] list failed: ${error.message}`);
    const rows = data ?? [];
    const users = await usersById(rows.map((r) => r.user_id));
    return c.json(
      {
        payments: rows.map((r) => toAdmin(r, nameOf(users.get(r.user_id)))),
        pagination: { page: q.page, limit: q.limit, total: count ?? rows.length },
      },
      200
    );
  }
);

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/providers",
    operationId: "adminListPaymentProviders",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    responses: { 200: json(AdminPaymentProvidersResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  (c) =>
    c.json(
      {
        public_api_url: env.PUBLIC_API_URL,
        providers: allProviders().map((p) => ({
          provider: p.id,
          configured: p.isConfigured(),
          test_mode: p.testMode(),
          methods: [...p.methods],
          currency: p.chargeCurrency?.() ?? "DZD",
          dzd_rate: p.dzdRate?.() ?? null,
          webhook_url:
            env.PUBLIC_API_URL && (p.id === "chargily" || p.id === "stripe")
              ? webhookUrl(env.PUBLIC_API_URL, env.BASE_PATH, p.id)
              : null,
        })),
      },
      200
    )
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/{id}/sync",
    operationId: "adminSyncPayment",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: PaymentIdParam },
    responses: {
      200: json(z.object({ payment: AdminPayment }).openapi("AdminPaymentResponse")),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { data } = await supabaseAdmin.from("payments").select("*").eq("id", id).maybeSingle();
    if (!data) return c.json({ error: "Payment not found" }, 404);
    // late: a re-check also credits money that arrived after the payment was closed.
    const after = await syncPayment(data, { late: true });
    // Audited when it changed something (e.g. a late card payment credited by this click).
    if (after.status !== data.status) {
      await recordFinanceAudit({
        actorId: c.get("user").id,
        action: "payment.sync",
        targetType: "payment",
        targetId: id,
        amount: Number(after.amount),
        details: { provider: after.provider, purpose: after.purpose, ref_id: after.ref_id, from: data.status, to: after.status },
      });
    }
    const users = await usersById([after.user_id]);
    return c.json({ payment: toAdmin(after, nameOf(users.get(after.user_id))) }, 200);
  }
);

export default app;
