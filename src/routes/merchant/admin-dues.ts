// Staff overview of merchant dues (the commission Blink is owed on store
// sales) + a nudge to pay. Tagged admin-* so it stays out of the mobile client
// (orval skips it); the dashboard calls it (super_admin / finance_admin). The
// math is the merchant app's own (dues-shared.ts → src/lib/merchant-dues.ts).
import {
  BLINK_CASH_HREF,
  DUES_REMINDER_COOLDOWN_MS,
  duesReminderCopy,
  remindedRecently,
} from "../../lib/merchant-dues";
import { duesPaymentCopy } from "../../lib/blink-cash-copy";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  AdminMerchantDuesResponse,
  DuesReminderError,
  RemindDuesResponse,
  StoreIdParam,
} from "../../validators/merchant";
import {
  DuesPaymentIdParam,
  DuesPaymentResponse,
  ReasonBody,
  RecordDuesPaymentBody,
} from "../../validators/blink-cash-admin";
import { notifyUser } from "../blink-cash/admin-shared";
import { duesForStores } from "./dues-shared";

const app = router();

/** Same roles as the dashboard's /blink-cash. */
const duesStaff = requireStaffRole("finance_admin");

type UserLite = { id: string; first_name: string | null; last_name: string | null; phone_number: string | null };

const nameOf = (u?: UserLite) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null;

async function usersById(ids: string[]) {
  const map = new Map<string, UserLite>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const { data } = await supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number")
      .in("id", unique.slice(i, i + 100));
    for (const u of (data ?? []) as UserLite[]) map.set(u.id, u);
  }
  return map;
}

// ─── Staff: every merchant store's dues + the latest payments ────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/dues",
    operationId: "listMerchantDuesAdmin",
    tags: ["admin-merchant"],
    security: bearer,
    middleware: [duesStaff] as const,
    responses: {
      200: json(AdminMerchantDuesResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const [{ data: stores, error: storesError }, { data: payments }] = await Promise.all([
      supabaseAdmin
        .from("stores")
        .select("id, name, owner_id")
        .not("owner_id", "is", null)
        // Allocation order within a merchant: primary first, then oldest.
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
      supabaseAdmin
        .from("merchant_dues_payments")
        .select("id, merchant_id, store_id, amount, fees, method, status, created_at")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    // Never show a short list as if it were complete.
    if (storesError) throw new Error(`[admin-dues] stores read failed: ${storesError.message}`);
    const dues = await duesForStores(stores ?? []);
    const users = await usersById([
      ...dues.map((d) => d.merchant_id),
      ...(payments ?? []).map((p) => p.merchant_id),
    ]);
    const storeNames = new Map((stores ?? []).map((s) => [s.id, s.name]));

    return c.json(
      {
        dues: dues
          .map((d) => ({
            store_id: d.store_id,
            store_name: d.store_name,
            merchant_id: d.merchant_id,
            merchant_name: nameOf(users.get(d.merchant_id)),
            merchant_phone: users.get(d.merchant_id)?.phone_number ?? null,
            commission_total: d.commission,
            paid_total: d.paid,
            outstanding: d.dues_payable,
            last_payment_at: d.last_payment_at,
          }))
          .sort((a, b) => b.outstanding - a.outstanding),
        payments: (payments ?? []).map((p) => ({
          id: p.id,
          store_id: p.store_id,
          store_name: p.store_id ? storeNames.get(p.store_id) ?? null : null,
          merchant_id: p.merchant_id,
          merchant_name: nameOf(users.get(p.merchant_id)),
          amount: Number(p.amount),
          fees: Number(p.fees),
          method: p.method,
          status: p.status,
          created_at: p.created_at,
        })),
      },
      200
    );
  }
);

// ─── Staff: remind a store owner of their outstanding dues ───────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/{store_id}/remind",
    operationId: "remindMerchantDues",
    tags: ["admin-merchant"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: StoreIdParam },
    responses: {
      200: json(RemindDuesResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(DuesReminderError, "Nothing outstanding (code nothing_outstanding)"),
      429: json(DuesReminderError, "Already reminded in the last 24 h (code recently_reminded)"),
      500: json(ErrorSchema, "The notification could not be saved"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { store_id } = c.req.valid("param");

    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("id, name, owner_id")
      .eq("id", store_id)
      .maybeSingle();
    if (!store?.owner_id) return c.json({ error: "Store not found" }, 404);

    // One reminder per store per day (a double click, or two staff at once).
    const { data: last, error: lastError } = await supabaseAdmin
      .from("notifications")
      .select("created_at")
      .contains("payload", { kind: "dues_reminder", store_id: store.id })
      .gte("created_at", new Date(Date.now() - DUES_REMINDER_COOLDOWN_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw new Error(`[admin-dues] reminder lookup failed: ${lastError.message}`);
    if (remindedRecently(last?.created_at)) {
      return c.json(
        { error: "This store was already reminded in the last 24 hours", code: "recently_reminded" as const },
        429
      );
    }

    // Allocate across all of the owner's stores (all-stores payments are shared).
    const { data: ownerStores, error: storesError } = await supabaseAdmin
      .from("stores")
      .select("id, name, owner_id")
      .eq("owner_id", store.owner_id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    if (storesError) throw new Error(`[admin-dues] stores read failed: ${storesError.message}`);
    const row = (await duesForStores(ownerStores ?? [])).find((d) => d.store_id === store.id);
    const outstanding = row?.dues_payable ?? 0;
    if (!(outstanding > 0)) {
      return c.json({ error: "No outstanding dues for this store", code: "nothing_outstanding" as const }, 409);
    }

    const { en, fr, ar } = duesReminderCopy(outstanding, store.name);
    const notif = await createNotification({
      userId: store.owner_id,
      role: "merchant",
      type: "alert",
      title: en.title,
      description: en.description,
      contentEng: en,
      contentFr: fr,
      contentAr: ar,
      href: BLINK_CASH_HREF,
      payload: { kind: "dues_reminder", store_id: store.id, store_name: store.name, amount: outstanding },
      createdBy: staff.id,
    }).catch(() => null);
    if (!notif) return c.json({ error: "Could not send the reminder" }, 500);

    return c.json({ ok: true as const }, 200);
  }
);

// ─── Staff: money received / payments to confirm ─────────────────────
const round2 = (n: number) => Math.round(n * 100) / 100;

const paymentResponses = {
  200: json(DuesPaymentResponse),
  400: errorResponses[400],
  401: errorResponses[401],
  403: errorResponses[403],
  404: errorResponses[404],
  409: errorResponses[409],
} as const;

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/{store_id}/payments",
    operationId: "recordMerchantDuesPaymentAdmin",
    tags: ["admin-merchant"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: StoreIdParam, body: { ...json(RecordDuesPaymentBody), required: true } },
    responses: {
      201: json(DuesPaymentResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { store_id } = c.req.valid("param");
    const body = c.req.valid("json");

    const { data: store } = await supabaseAdmin.from("stores").select("id, owner_id").eq("id", store_id).maybeSingle();
    if (!store?.owner_id) return c.json({ error: "Store not found" }, 404);

    const amount = round2(body.amount);
    const { data, error } = await supabaseAdmin
      .from("merchant_dues_payments")
      .insert({
        merchant_id: store.owner_id,
        store_id: store.id,
        amount,
        // No processing fee on money Blink received in person / by transfer.
        fees: 0,
        method: body.method,
        status: "completed",
        reference: body.reference ?? null,
        note: body.note ?? null,
        recorded_by: staff.id,
        confirmed_by: staff.id,
        confirmed_at: new Date().toISOString(),
      })
      .select()
      .single();
    if (error || !data) throw new Error(`[admin-dues] payment insert failed: ${error?.message}`);

    await recordFinanceAudit({
      actorId: staff.id,
      action: "merchant_dues.record",
      targetType: "merchant_dues_payment",
      targetId: data.id,
      amount,
      details: { merchant_id: store.owner_id, store_id: store.id, method: body.method, reference: body.reference ?? null, note: body.note ?? null },
    });
    await notifyUser({
      userId: store.owner_id,
      role: "merchant",
      copy: duesPaymentCopy("recorded", amount),
      href: BLINK_CASH_HREF,
      payload: { kind: "dues_payment", payment_id: data.id, store_id: store.id },
      createdBy: staff.id,
    });
    return c.json({ payment: data as Record<string, unknown> }, 201);
  }
);

/** Settle a pending app payment (atomic: only a still-pending row changes), audit, notify. */
async function settlePayment(staffId: string, id: string, confirmed: boolean, reason?: string) {
  const now = new Date().toISOString();
  const patch = confirmed
    ? { status: "completed", confirmed_by: staffId, confirmed_at: now }
    : { status: "cancelled", confirmed_by: staffId, confirmed_at: now, rejected_reason: reason };
  const { data, error } = await supabaseAdmin
    .from("merchant_dues_payments")
    .update(patch)
    .eq("id", id)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (error) throw new Error(`[admin-dues] payment update failed: ${error.message}`);
  if (!data) {
    const { data: existing } = await supabaseAdmin.from("merchant_dues_payments").select("id").eq("id", id).maybeSingle();
    return { found: false as const, exists: !!existing };
  }

  const amount = Number(data.amount);
  await recordFinanceAudit({
    actorId: staffId,
    action: confirmed ? "merchant_dues.confirm" : "merchant_dues.reject",
    targetType: "merchant_dues_payment",
    targetId: id,
    amount,
    reason,
    details: { merchant_id: data.merchant_id, store_id: data.store_id, method: data.method, reference: data.reference ?? null },
  });
  await notifyUser({
    userId: data.merchant_id,
    role: "merchant",
    copy: duesPaymentCopy(confirmed ? "confirmed" : "rejected", amount),
    href: BLINK_CASH_HREF,
    payload: { kind: confirmed ? "dues_payment" : "dues_payment_rejected", payment_id: id },
    createdBy: staffId,
  });
  return { found: true as const, payment: data as Record<string, unknown> };
}

const settleErrors = (r: { exists: boolean }) =>
  r.exists
    ? ({ status: 409, body: { error: "The payment is not pending", code: "not_pending" } } as const)
    : ({ status: 404, body: { error: "Payment not found", code: "not_found" } } as const);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/payments/{id}/confirm",
    operationId: "confirmMerchantDuesPaymentAdmin",
    tags: ["admin-merchant"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: DuesPaymentIdParam },
    responses: paymentResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const r = await settlePayment(c.get("user").id, id, true);
    if (r.found) return c.json({ payment: r.payment }, 200);
    const e = settleErrors(r);
    return e.status === 409 ? c.json(e.body, 409) : c.json(e.body, 404);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/payments/{id}/reject",
    operationId: "rejectMerchantDuesPaymentAdmin",
    tags: ["admin-merchant"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: DuesPaymentIdParam, body: { ...json(ReasonBody), required: true } },
    responses: paymentResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    const r = await settlePayment(c.get("user").id, id, false, reason);
    if (r.found) return c.json({ payment: r.payment }, 200);
    const e = settleErrors(r);
    return e.status === 409 ? c.json(e.body, 409) : c.json(e.body, 404);
  }
);

export default app;
