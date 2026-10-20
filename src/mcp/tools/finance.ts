import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange, maskRib } from "../../lib/mcp-util";
import {
  computeAgentDues,
  computeAgentDuesBatch,
  fallbackRatesFor,
  listAgentIds,
  splitTxFee,
} from "../../lib/agent-finance";
import { getBlinkCashSettings } from "../../lib/blink-cash-settings";
import { agentLimitFor } from "../../lib/blink-cash-requests";
import { agentCapacity, round2 } from "../../lib/blink-cash-rules";
import { getPrice } from "../../lib/pricing";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ROLES = ["finance_admin", "ops_admin"] as const;
const num = (v: unknown) => Number(v ?? 0);

type NameRow = { id: string; first_name: string | null; last_name: string | null };
const fullName = (u?: NameRow | null) => (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null);

/** id -> display name for a set of user ids (one query). */
export async function namesFor(ids: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  const out = new Map<string, string | null>();
  if (!uniq.length) return out;
  const { data } = must(await supabaseAdmin.from("users").select("id, first_name, last_name").in("id", uniq));
  for (const u of data as unknown as NameRow[]) out.set(u.id, fullName(u));
  return out;
}

/** Payout account with the number masked to its last 4. */
export function maskPayout(p: { type?: string; number?: string; holder?: string } | null | undefined) {
  if (!p) return null;
  return { type: p.type ?? null, number: maskRib(p.number), holder: p.holder ?? null };
}

/** Group rows by key into count + amount sums. */
export function tally<T>(rows: T[], key: (r: T) => string, amount: (r: T) => number) {
  const out: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) {
    const k = key(r);
    const e = (out[k] ??= { count: 0, amount: 0 });
    e.count += 1;
    e.amount = round2(e.amount + amount(r));
  }
  return out;
}

// ---------------------------------------------------------------- 1
export const getWalletLedger = defineTool({
  name: "get_wallet_ledger",
  title: "Get wallet ledger",
  description:
    "A user's Blink Cash ledger wallet (DZD): balance, held, available, frozen status, plus ledger entries newest first. Filters: kind, created_from/to. Entry amount is signed; balance_after is the running balance.",
  roles: [...ROLES],
  input: {
    user_id: uuidField("User id"),
    kind: z
      .enum(["opening_balance", "deposit", "withdrawal", "trip", "challenge_reward", "offer_bonus", "adjustment", "reversal"])
      .optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const { data: ws } = must(
      await supabaseAdmin
        .from("blink_wallets")
        .select("id, role, balance, held, status, frozen_reason, frozen_at, backfilled_at, updated_at")
        .eq("user_id", a.user_id)
    );
    const wallets = ws as unknown as Record<string, any>[];
    if (!wallets.length) return { data: { wallets: [], entries: listResult([], 0, 0), note: "No ledger wallet." }, rowCount: 0 };
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin
      .from("blink_wallet_entries")
      .select("id, wallet_id, kind, amount, balance_after, transaction_id, ref_type, ref_id, memo, actor_id, created_at", {
        count: "exact",
      })
      .in("wallet_id", wallets.map((w) => w.id));
    if (a.kind) q = q.eq("kind", a.kind);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return {
      data: {
        currency: "DZD",
        wallets: wallets.map((w) => ({
          wallet_id: w.id,
          role: w.role,
          balance: num(w.balance),
          held: num(w.held),
          available: round2(num(w.balance) - num(w.held)),
          frozen: w.status === "frozen",
          frozen_reason: w.frozen_reason,
          frozen_at: w.frozen_at,
          backfilled: !!w.backfilled_at,
        })),
        entries: listResult(items, count, offset),
      },
      rowCount: items.length,
    };
  },
});

// ---------------------------------------------------------------- 2
export const listCashReviews = defineTool({
  name: "list_cash_reviews",
  title: "List cash reviews",
  description:
    "Electronic Blink Cash deposits/withdrawals awaiting staff review (status review), oldest first: rider name, amount/fees/total (DZD), method, reference, masked payout account, has_receipt, age_minutes.",
  roles: [...ROLES],
  input: { type: z.enum(["deposit", "withdrawal"]).optional(), limit: limitField, offset: offsetField },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("transactions")
      .select("id, type, user_id, amount, fees, total, method, reference, payout_account, receipt_url, created_at", {
        count: "exact",
      })
      .eq("status", "review");
    if (a.type) q = q.eq("type", a.type);
    const { data, count } = must(await q.order("created_at", { ascending: true }).range(from, to));
    const rows = data as unknown as Record<string, any>[];
    const names = await namesFor(rows.map((r) => r.user_id));
    const now = Date.now();
    const items = rows.map((r) => ({
      id: r.id,
      type: r.type,
      user_id: r.user_id,
      rider_name: names.get(r.user_id) ?? null,
      amount: num(r.amount),
      fees: num(r.fees),
      total: num(r.total),
      method: r.method,
      reference: r.reference,
      payout_account: maskPayout(r.payout_account),
      has_receipt: !!r.receipt_url,
      created_at: r.created_at,
      age_minutes: Math.max(0, Math.round((now - Date.parse(r.created_at)) / 60000)),
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ---------------------------------------------------------------- 3
export const getAgentDues = defineTool({
  name: "get_agent_dues",
  title: "Get agent dues",
  description:
    "One agent's cash dues to Blink (DZD): total_dues, credit, breakdown, credit limit, remaining capacity, and the last 5 dues payments (amount, status, method, reference).",
  roles: [...ROLES],
  input: { agent_id: uuidField("Agent user id") },
  handler: async ({ agent_id }) => {
    const [dues, settings, pays, names] = await Promise.all([
      computeAgentDues(agent_id),
      getBlinkCashSettings(),
      supabaseAdmin
        .from("agent_dues_payments")
        .select("id, amount, fees, method, status, reference, created_at")
        .eq("agent_id", agent_id)
        .order("created_at", { ascending: false })
        .limit(5),
      namesFor([agent_id]),
    ]);
    const limit = await agentLimitFor(agent_id, settings);
    return {
      data: {
        agent_id,
        agent_name: names.get(agent_id) ?? null,
        currency: "DZD",
        dues,
        credit_limit: limit,
        capacity: agentCapacity(dues.total_dues, limit),
        last_payments: must(pays).data,
      },
      rowCount: 1,
    };
  },
});

// ---------------------------------------------------------------- 4
export const listAgentDuesTool = defineTool({
  name: "list_agent_dues",
  title: "List agent dues",
  description:
    "Agents ranked by outstanding cash dues to Blink, highest first (DZD): name, total_dues, credit, credit_limit, capacity. Only agents with dues > 0 unless include_zero. Computed over all agents.",
  roles: [...ROLES],
  input: { include_zero: z.boolean().optional(), limit: limitField, offset: offsetField },
  handler: async (a) => {
    const { offset, limit } = page(a);
    const ids = await listAgentIds();
    const dues = await computeAgentDuesBatch(ids);
    let ranked = [...dues].sort((x, y) => y[1].total_dues - x[1].total_dues);
    if (!a.include_zero) ranked = ranked.filter(([, d]) => d.total_dues > 0);
    const total = ranked.length;
    const slice = ranked.slice(offset, offset + limit);
    const settings = await getBlinkCashSettings();
    const sliceIds = slice.map(([id]) => id);
    const [names, profiles] = await Promise.all([
      namesFor(sliceIds),
      sliceIds.length
        ? supabaseAdmin.from("agent_profiles").select("user_id, credit_limit").in("user_id", sliceIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const own = new Map<string, number | null>(
      ((profiles.data ?? []) as any[]).map((p) => [p.user_id, p.credit_limit == null ? null : Number(p.credit_limit)])
    );
    const items = slice.map(([id, d]) => {
      const lim = own.get(id) ?? settings.agent_credit_limit;
      return {
        agent_id: id,
        name: names.get(id) ?? null,
        total_dues: d.total_dues,
        credit: d.credit,
        credit_limit: lim,
        capacity: agentCapacity(d.total_dues, lim),
      };
    });
    return { data: { currency: "DZD", ...listResult(items, total, offset) }, rowCount: items.length };
  },
});

// ---------------------------------------------------------------- 5
export const listDuesPayments = defineTool({
  name: "list_dues_payments",
  title: "List dues payments",
  description:
    "Dues payments newest first (DZD). party=agent|merchant. Filters: status (pending|completed|cancelled|review|reversed), party_id (agent/merchant user id), created_from/to. Shows amount, fees, method, reference, recorded/confirmed by names, dates.",
  roles: [...ROLES],
  input: {
    party: z.enum(["agent", "merchant"]),
    status: z.enum(["pending", "completed", "cancelled", "review", "reversed"]).optional(),
    party_id: uuidField("Agent or merchant user id").optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const agent = a.party === "agent";
    const table = agent ? "agent_dues_payments" : "merchant_dues_payments";
    const pcol = agent ? "agent_id" : "merchant_id";
    const cols = `id, ${pcol}, ${agent ? "" : "store_id, "}amount, fees, method, status, reference, note, recorded_by, confirmed_by, confirmed_at, rejected_reason, created_at`;
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin.from(table).select(cols, { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.party_id) q = q.eq(pcol, a.party_id);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Record<string, any>[];
    const names = await namesFor(rows.flatMap((x) => [x[pcol], x.recorded_by, x.confirmed_by]));
    const items = rows.map((x) => ({
      ...x,
      amount: num(x.amount),
      fees: num(x.fees),
      party_name: names.get(x[pcol]) ?? null,
      recorded_by_name: x.recorded_by ? (names.get(x.recorded_by) ?? null) : null,
      confirmed_by_name: x.confirmed_by ? (names.get(x.confirmed_by) ?? null) : null,
    }));
    return { data: { party: a.party, ...listResult(items, count, offset) }, rowCount: items.length };
  },
});

// ---------------------------------------------------------------- 6
export const getBlinkCashConfig = defineTool({
  name: "get_blink_cash_config",
  title: "Get Blink Cash config",
  description:
    "Blink Cash config: amount/daily/monthly limits, pending expiry, electronic enabled, PIN-for-withdrawal, agent credit limit, current national fee rates from Pricing (deposit/withdrawal; wilaya overrides may apply), active offers. Electronic account numbers masked.",
  roles: [...ROLES],
  input: {},
  handler: async () => {
    const [s, dep, wd, offers] = await Promise.all([
      getBlinkCashSettings(),
      getPrice("blink_cash_fee_rate", { service: "deposit" }),
      getPrice("blink_cash_fee_rate", { service: "withdrawal" }),
      supabaseAdmin
        .from("blink_cash_offers")
        .select("id, title, min_deposit, bonus_type, bonus_value, max_bonus, starts_at, ends_at, per_user_limit, budget, used_count, used_amount")
        .eq("active", true)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    return {
      data: {
        currency: "DZD",
        limits: {
          min_amount: s.min_amount,
          max_amount: s.max_amount,
          daily_deposit: s.daily_deposit_limit,
          daily_withdrawal: s.daily_withdrawal_limit,
          monthly_deposit: s.monthly_deposit_limit,
          monthly_withdrawal: s.monthly_withdrawal_limit,
        },
        pending_expiry_minutes: s.pending_expiry_minutes,
        electronic_enabled: s.electronic_enabled,
        electronic_accounts: s.electronic_accounts.map((x) => ({ label: x.label, type: x.type, number: maskRib(x.number) })),
        require_pin_for_withdrawal: s.require_pin_for_withdrawal,
        agent_credit_limit: s.agent_credit_limit,
        adjust_limit_finance_admin: s.adjust_limit_finance_admin,
        fee_rates: {
          deposit: dep.value.rate,
          withdrawal: wd.value.rate,
          source: "Pricing & Fees (national default); wilaya overrides may apply",
        },
        active_offers: must(offers).data,
      },
      rowCount: 1,
    };
  },
});

// ---------------------------------------------------------------- 7
export const listFinanceAudit = defineTool({
  name: "list_finance_audit",
  title: "List finance audit",
  description:
    "Finance audit trail (staff writes on Blink Cash) newest first: action, actor name, target type/id, amount (DZD), reason, details. Filters: actor_id, target_id, action, created_from/to.",
  roles: ["finance_admin"],
  input: {
    actor_id: uuidField("Staff actor user id").optional(),
    target_id: z.string().max(80).optional().describe("Target id (transaction, user, payment…)"),
    action: z.string().max(80).optional().describe("Exact action name"),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin
      .from("finance_audit_events")
      .select("id, actor_id, action, target_type, target_id, amount, reason, details, created_at", { count: "exact" });
    if (a.actor_id) q = q.eq("actor_id", a.actor_id);
    if (a.target_id) q = q.eq("target_id", a.target_id);
    if (a.action) q = q.eq("action", a.action);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as Record<string, any>[];
    const names = await namesFor(rows.map((x) => x.actor_id));
    const items = rows.map((x) => ({
      ...x,
      amount: x.amount == null ? null : num(x.amount),
      actor_name: x.actor_id ? (names.get(x.actor_id) ?? null) : null,
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ---------------------------------------------------------------- 8
const SUMMARY_CAP = 5000;

export const cashFlowSummary = defineTool({
  name: "cash_flow_summary",
  title: "Cash flow summary",
  description:
    "Blink Cash flow for a date range (default today, Africa/Algiers; DZD): count+amount by type/status/method, fee split (platform/tax/agents net) of completed agent operations, reversals, current review/pending counts. Reads up to 5000 rows.",
  roles: [...ROLES],
  input: { created_from: createdFrom, created_to: createdTo },
  handler: async (a) => {
    const today = new Date(Date.now() + 3600_000).toISOString().slice(0, 10);
    const r = dateRange(a.created_from ?? today, a.created_to ?? (a.created_from ? undefined : today));
    let q = supabaseAdmin
      .from("transactions")
      .select("type, status, method, agent_id, amount, fees, platform_share_rate, tax_rate")
      .order("created_at", { ascending: false })
      .limit(SUMMARY_CAP);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const rows = must(await q).data as unknown as Record<string, any>[];
    const truncated = rows.length >= SUMMARY_CAP;

    const by = (k: (t: Record<string, any>) => string) => tally(rows, k, (t) => num(t.amount));
    const completedAgent = rows.filter((t) => t.status === "completed" && t.agent_id);
    const byAgent = new Map<string, Record<string, any>[]>();
    for (const t of completedAgent) (byAgent.get(t.agent_id) ?? byAgent.set(t.agent_id, []).get(t.agent_id)!).push(t);
    const fallback = await fallbackRatesFor(byAgent);
    let platform = 0;
    let tax = 0;
    let net = 0;
    let feesTotal = 0;
    for (const [id, txs] of byAgent) {
      for (const t of txs) {
        const s = splitTxFee(t, fallback.get(id));
        platform += s.platform;
        tax += s.tax;
        net += s.net;
        feesTotal += num(t.fees);
      }
    }
    const electronicFees = rows
      .filter((t) => t.status === "completed" && !t.agent_id)
      .reduce((s, t) => s + num(t.fees), 0);

    const [review, pending] = await Promise.all(
      (["review", "pending"] as const).map((st) =>
        supabaseAdmin.from("transactions").select("id", { count: "exact", head: true }).eq("status", st)
      )
    );
    return {
      data: {
        currency: "DZD",
        range: { from: r.gte ?? null, to: r.lt ?? null },
        rows_read: rows.length,
        truncated,
        by_type_status: by((t) => `${t.type}:${t.status}`),
        by_method: by((t) => `${t.type}:${t.method ?? "unknown"}`),
        fee_split_agent_operations: {
          operations: completedAgent.length,
          fees_total: round2(feesTotal),
          platform: round2(platform),
          tax: round2(tax),
          agents_net: round2(net),
        },
        electronic_completed_fees: round2(electronicFees),
        reversals: tally(
          rows.filter((t) => t.status === "reversed"),
          (t) => t.type,
          (t) => num(t.amount)
        ),
        current_counts: { review: review.count ?? 0, pending: pending.count ?? 0 },
      },
      rowCount: rows.length,
    };
  },
});

export const FINANCE_TOOLS = [
  getWalletLedger,
  listCashReviews,
  getAgentDues,
  listAgentDuesTool,
  listDuesPayments,
  getBlinkCashConfig,
  listFinanceAudit,
  cashFlowSummary,
];
