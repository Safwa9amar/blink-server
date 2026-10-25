// Staff overview of agent Blink Cash dues (the cash agents owe Blink on the
// deposits / withdrawals they process) + a nudge to pay. Tagged admin-* so it
// stays out of the mobile client (orval skips it); the dashboard calls it
// (super_admin / finance_admin). The math is lib/agent-finance.ts, batched.
import { isOnlineDuesPayment, PAID_ONLINE } from "../../lib/payments/service";
import {
  agentDuesFromRows,
  fallbackRatesFor,
  fetchAllRows,
  listAgentIds,
  loadAgentLedgers,
  round2,
  splitTxFee,
} from "../../lib/agent-finance";
import { AGENT_DUES_HREF, agentDuesReminderCopy, DUES_REMINDER_COOLDOWN_MS, remindedRecently } from "../../lib/agent-dues-reminder";
import { createNotification } from "../../lib/notifications";
import { duesPaymentCopy } from "../../lib/blink-cash-copy";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { notifyUser } from "../blink-cash/admin-shared";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  AdminAgentDuesResponse,
  AgentDuesReminderError,
  AgentIdParam,
  RemindAgentDuesResponse,
} from "../../validators/blink-cash";
import {
  AgentCreditLimitBody,
  AgentCreditLimitResponse,
  DuesPaymentIdParam,
  DuesPaymentResponse,
  ReasonBody,
  RecordDuesPaymentBody,
} from "../../validators/blink-cash-admin";

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
    const { data, error } = await supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number")
      .in("id", unique.slice(i, i + 100));
    if (error) throw new Error(`[agent-admin-dues] users read failed: ${error.message}`);
    for (const u of (data ?? []) as UserLite[]) map.set(u.id, u);
  }
  return map;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const later = (a: string | null, b: string) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

// ─── Staff: every agent's dues, activity and the latest payments ─────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/dues",
    operationId: "listAgentDuesAdmin",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    responses: {
      200: json(AdminAgentDuesResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    // Never show a short list as if it were complete: any failed base read throws.
    const agentIds = await listAgentIds();
    const [ledgers, shops, { data: payments, error: paymentsError }] = await Promise.all([
      loadAgentLedgers(agentIds),
      fetchAllRows<{
        id: string;
        user_id: string;
        shop_name: string;
        address: string | null;
        latitude: number | null;
        longitude: number | null;
        status: string;
        is_primary: boolean;
        created_at: string;
      }>((from, to) =>
        supabaseAdmin
          .from("agent_shops")
          .select("id, user_id, shop_name, address, latitude, longitude, status, is_primary, created_at")
          .order("id")
          .range(from, to) as any
      ),
      supabaseAdmin
        .from("agent_dues_payments")
        .select("id, agent_id, amount, fees, method, status, created_at")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    if (paymentsError) throw new Error(`[agent-admin-dues] payments read failed: ${paymentsError.message}`);

    const users = await usersById([...agentIds, ...(payments ?? []).map((p) => p.agent_id)]);

    const shopsByAgent = new Map<string, typeof shops>();
    for (const s of shops) shopsByAgent.set(s.user_id, [...(shopsByAgent.get(s.user_id) ?? []), s]);
    const primaryShop = (id: string) => {
      const own = shopsByAgent.get(id) ?? [];
      return own.find((s) => s.is_primary) ?? [...own].sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    };
    // Current rates, only for agents with operations older than the rate snapshot.
    const fallback = await fallbackRatesFor(ledgers.txs, (id) => primaryShop(id) ?? null);

    const since30 = Date.now() - 30 * DAY_MS;
    const agents = agentIds.map((id) => {
      const txs = ledgers.txs.get(id) ?? [];
      const pays = ledgers.payments.get(id) ?? [];
      const dues = agentDuesFromRows(txs, ledgers.rewards.get(id) ?? [], pays, fallback.get(id));

      const dep = { count: 0, amount: 0 };
      const wd = { count: 0, amount: 0 };
      let net = 0;
      let ops30 = 0;
      let lastOp: string | null = null;
      let ratingSum = 0;
      let ratings = 0;
      for (const t of txs) {
        const bucket = t.type === "deposit" ? dep : wd;
        bucket.count++;
        bucket.amount += Number(t.amount);
        net += splitTxFee(t, fallback.get(id)).net;
        if (Date.parse(t.created_at) >= since30) ops30++;
        lastOp = later(lastOp, t.created_at);
        if (t.rating != null) {
          ratingSum += Number(t.rating);
          ratings++;
        }
      }
      let lastPay: string | null = null;
      for (const p of pays) lastPay = later(lastPay, p.created_at);

      const own = shopsByAgent.get(id) ?? [];
      const primary = primaryShop(id);
      const user = users.get(id);
      return {
        agent_id: id,
        name: nameOf(user),
        phone: user?.phone_number ?? null,
        shops_total: own.length,
        shops_open: own.filter((s) => s.status === "open").length,
        primary_shop: primary
          ? {
              id: primary.id,
              name: primary.shop_name,
              address: primary.address,
              lat: primary.latitude,
              lng: primary.longitude,
            }
          : null,
        deposits: { count: dep.count, amount: round2(dep.amount) },
        withdrawals: { count: wd.count, amount: round2(wd.amount) },
        operations_30d: ops30,
        fee_income_net: round2(net),
        total_dues: dues.total_dues,
        credit: dues.credit,
        last_operation_at: lastOp,
        last_payment_at: lastPay,
        rating_avg: ratings ? round2(ratingSum / ratings) : null,
        ratings_count: ratings,
      };
    });
    agents.sort((a, b) => b.total_dues - a.total_dues);

    return c.json(
      {
        agents,
        payments: (payments ?? []).map((p) => ({
          id: p.id,
          agent_id: p.agent_id,
          agent_name: nameOf(users.get(p.agent_id)),
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

// ─── Staff: remind an agent of their outstanding dues ────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/{agent_id}/remind",
    operationId: "remindAgentDues",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: AgentIdParam },
    responses: {
      200: json(RemindAgentDuesResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(AgentDuesReminderError, "Nothing outstanding (code nothing_outstanding)"),
      429: json(AgentDuesReminderError, "Already reminded in the last 24 h (code reminded_recently)"),
      500: json(ErrorSchema, "The notification could not be saved"),
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { agent_id } = c.req.valid("param");

    const [{ data: profile }, { data: shop }] = await Promise.all([
      supabaseAdmin.from("agent_profiles").select("user_id").eq("user_id", agent_id).maybeSingle(),
      supabaseAdmin.from("agent_shops").select("id").eq("user_id", agent_id).limit(1).maybeSingle(),
    ]);
    if (!profile && !shop) return c.json({ error: "Agent not found" }, 404);

    const { data: last, error: lastError } = await supabaseAdmin
      .from("notifications")
      .select("created_at")
      .contains("payload", { kind: "dues_reminder", agent_id })
      .gte("created_at", new Date(Date.now() - DUES_REMINDER_COOLDOWN_MS).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastError) throw new Error(`[agent-admin-dues] reminder lookup failed: ${lastError.message}`);
    if (remindedRecently(last?.created_at)) {
      return c.json(
        { error: "This agent was already reminded in the last 24 hours", code: "reminded_recently" as const },
        429
      );
    }

    const l = await loadAgentLedgers([agent_id]);
    const fallback = await fallbackRatesFor(l.txs);
    const { total_dues } = agentDuesFromRows(
      l.txs.get(agent_id) ?? [],
      l.rewards.get(agent_id) ?? [],
      l.payments.get(agent_id) ?? [],
      fallback.get(agent_id)
    );
    if (!(total_dues > 0)) {
      return c.json({ error: "No outstanding dues for this agent", code: "nothing_outstanding" as const }, 409);
    }

    const { en, fr, ar } = agentDuesReminderCopy(total_dues);
    const notif = await createNotification({
      userId: agent_id,
      role: "agent",
      type: "alert",
      title: en.title,
      description: en.description,
      contentEng: en,
      contentFr: fr,
      contentAr: ar,
      href: AGENT_DUES_HREF,
      payload: { kind: "dues_reminder", agent_id, amount: total_dues },
      createdBy: staff.id,
    }).catch(() => null);
    if (!notif) return c.json({ error: "Could not send the reminder" }, 500);

    return c.json({ ok: true as const }, 200);
  }
);

// ─── Staff: money received / payments to confirm ─────────────────────
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
    path: "/admin/dues/{agent_id}/payments",
    operationId: "recordAgentDuesPaymentAdmin",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: AgentIdParam, body: { ...json(RecordDuesPaymentBody), required: true } },
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
    const { agent_id } = c.req.valid("param");
    const body = c.req.valid("json");

    const [{ data: profile }, { data: shop }] = await Promise.all([
      supabaseAdmin.from("agent_profiles").select("user_id").eq("user_id", agent_id).maybeSingle(),
      supabaseAdmin.from("agent_shops").select("id").eq("user_id", agent_id).limit(1).maybeSingle(),
    ]);
    if (!profile && !shop) return c.json({ error: "Agent not found" }, 404);

    const amount = round2(body.amount);
    const now = new Date().toISOString();
    const { data, error } = await supabaseAdmin
      .from("agent_dues_payments")
      .insert({
        agent_id,
        amount,
        // No processing fee on money Blink received in person / by transfer.
        fees: 0,
        method: body.method,
        status: "completed",
        reference: body.reference ?? null,
        note: body.note ?? null,
        recorded_by: staff.id,
        confirmed_by: staff.id,
        confirmed_at: now,
      })
      .select()
      .single();
    if (error || !data) throw new Error(`[agent-admin-dues] payment insert failed: ${error?.message}`);

    await recordFinanceAudit({
      actorId: staff.id,
      action: "agent_dues.record",
      targetType: "agent_dues_payment",
      targetId: data.id,
      amount,
      details: { agent_id, method: body.method, reference: body.reference ?? null, note: body.note ?? null },
    });
    await notifyUser({
      userId: agent_id,
      role: "agent",
      copy: duesPaymentCopy("recorded", amount),
      href: AGENT_DUES_HREF,
      payload: { kind: "dues_payment", payment_id: data.id, agent_id },
      createdBy: staff.id,
    });
    return c.json({ payment: data as Record<string, unknown> }, 201);
  }
);

/** Settle a pending app payment: only a still-pending row can change (atomic). */
async function resolvePending(opts: {
  id: string;
  staffId: string;
  outcome: "confirmed" | "rejected";
  reason?: string;
}) {
  const now = new Date().toISOString();
  const patch =
    opts.outcome === "confirmed"
      ? { status: "completed", confirmed_by: opts.staffId, confirmed_at: now }
      : { status: "cancelled", confirmed_by: opts.staffId, confirmed_at: now, rejected_reason: opts.reason };
  const { data, error } = await supabaseAdmin
    .from("agent_dues_payments")
    .update(patch)
    .eq("id", opts.id)
    .eq("status", "pending")
    .select()
    .maybeSingle();
  if (error) throw new Error(`[agent-admin-dues] payment update failed: ${error.message}`);
  if (data) return { found: true as const, payment: data as Record<string, any> };
  const { data: existing } = await supabaseAdmin.from("agent_dues_payments").select("id").eq("id", opts.id).maybeSingle();
  return { found: false as const, exists: !!existing };
}

/** Resolve a pending payment, audit it and tell the agent. */
async function settlePayment(staffId: string, id: string, confirmed: boolean, reason?: string) {
  const r = await resolvePending({ id, staffId, outcome: confirmed ? "confirmed" : "rejected", reason });
  if (!r.found) return r;
  const amount = Number(r.payment.amount);
  await recordFinanceAudit({
    actorId: staffId,
    action: confirmed ? "agent_dues.confirm" : "agent_dues.reject",
    targetType: "agent_dues_payment",
    targetId: id,
    amount,
    reason,
    details: { agent_id: r.payment.agent_id, method: r.payment.method, reference: r.payment.reference ?? null },
  });
  await notifyUser({
    userId: r.payment.agent_id,
    role: "agent",
    copy: duesPaymentCopy(confirmed ? "confirmed" : "rejected", amount),
    href: AGENT_DUES_HREF,
    payload: { kind: confirmed ? "dues_payment" : "dues_payment_rejected", payment_id: id },
    createdBy: staffId,
  });
  return r;
}

const settleErrors = (r: { exists: boolean }) =>
  r.exists
    ? ({ status: 409, body: { error: "The payment is not pending", code: "not_pending" } } as const)
    : ({ status: 404, body: { error: "Payment not found", code: "not_found" } } as const);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/dues/payments/{id}/confirm",
    operationId: "confirmAgentDuesPaymentAdmin",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: DuesPaymentIdParam },
    responses: paymentResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    // A gateway payment completes (or lapses) by itself: staff never settle it.
    if (await isOnlineDuesPayment("agent_dues", id)) return c.json(PAID_ONLINE, 409);
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
    operationId: "rejectAgentDuesPaymentAdmin",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: DuesPaymentIdParam, body: { ...json(ReasonBody), required: true } },
    responses: paymentResponses,
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");
    if (await isOnlineDuesPayment("agent_dues", id)) return c.json(PAID_ONLINE, 409);
    const r = await settlePayment(c.get("user").id, id, false, reason);
    if (r.found) return c.json({ payment: r.payment }, 200);
    const e = settleErrors(r);
    return e.status === 409 ? c.json(e.body, 409) : c.json(e.body, 404);
  }
);

// ─── Staff: per-agent cash limit (null = the settings default) ───────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/{agent_id}/credit-limit",
    operationId: "setAgentCreditLimitAdmin",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [duesStaff] as const,
    request: { params: AgentIdParam, body: { ...json(AgentCreditLimitBody), required: true } },
    responses: {
      200: json(AgentCreditLimitResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const staff = c.get("user");
    const { agent_id } = c.req.valid("param");
    const { credit_limit } = c.req.valid("json");

    const { data: before, error: readError } = await supabaseAdmin
      .from("agent_profiles")
      .select("user_id, credit_limit")
      .eq("user_id", agent_id)
      .maybeSingle();
    if (readError) throw new Error(`[agent-admin-dues] profile read failed: ${readError.message}`);
    if (!before) return c.json({ error: "Agent not found" }, 404);

    const next = credit_limit == null ? null : round2(credit_limit);
    const { error } = await supabaseAdmin.from("agent_profiles").update({ credit_limit: next }).eq("user_id", agent_id);
    if (error) throw new Error(`[agent-admin-dues] credit limit write failed: ${error.message}`);

    await recordFinanceAudit({
      actorId: staff.id,
      action: "agent.credit_limit",
      targetType: "agent",
      targetId: agent_id,
      amount: next,
      details: { before: before.credit_limit == null ? null : Number(before.credit_limit), after: next },
    });
    return c.json({ agent_id, credit_limit: next }, 200);
  }
);

export default app;
