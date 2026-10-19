// Staff Blink Cash overview (money in wallets, deposits / withdrawals, fees,
// agent cash owed). Tagged admin-* so orval skips it; the dashboard calls it
// (super_admin / finance_admin). Money rules are the platform's own:
// riderWallet (lib/dispatch.ts) and splitFee / agent dues (lib/agent-finance.ts).
import { computeAgentDuesBatch, fallbackRatesFor, fetchAllRows, listAgentIds, round2, splitTxFee } from "../../lib/agent-finance";
import { bucketDaily, windowStartIso } from "../../lib/blink-cash-summary";
import { riderWallet } from "../../lib/dispatch";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AdminBlinkCashSummaryQuery, AdminBlinkCashSummaryResponse } from "../../validators/blink-cash";

const app = router();

const staff = requireStaffRole("finance_admin");
const WALLET_CONCURRENCY = 8;

type TxRow = {
  type: string;
  status: string;
  amount: number | string;
  fees: number | string | null;
  agent_id: string | null;
  created_at: string;
  platform_share_rate?: number | string | null;
  tax_rate?: number | string | null;
};

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/summary",
    operationId: "getBlinkCashSummaryAdmin",
    tags: ["admin-blink-cash"],
    security: bearer,
    middleware: [staff] as const,
    request: { query: AdminBlinkCashSummaryQuery },
    responses: {
      200: json(AdminBlinkCashSummaryResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const days = Number(c.req.valid("query").days ?? 30);
    const now = new Date();
    const since = windowStartIso(days, now);

    const [riders, completed, pending, agentIds] = await Promise.all([
      fetchAllRows<{ user_id: string }>((from, to) =>
        supabaseAdmin.from("rider_profiles").select("user_id").order("user_id").range(from, to) as any
      ),
      fetchAllRows<TxRow>((from, to) =>
        supabaseAdmin
          .from("transactions")
          .select("id, type, status, amount, fees, platform_share_rate, tax_rate, agent_id, created_at")
          .eq("status", "completed")
          .gte("created_at", since)
          .order("id")
          .range(from, to) as any
      ),
      fetchAllRows<TxRow>((from, to) =>
        supabaseAdmin
          .from("transactions")
          .select("id, type, status, amount, fees, agent_id, created_at")
          .eq("status", "pending")
          .order("id")
          .range(from, to) as any
      ),
      listAgentIds(),
    ]);

    const [wallets, agentDues] = await Promise.all([
      mapLimit(riders, WALLET_CONCURRENCY, (r) => riderWallet(r.user_id)),
      computeAgentDuesBatch(agentIds),
    ]);

    const circulation = { total: 0, available: 0, pending_withdrawals: 0, wallets: 0 };
    for (const w of wallets) {
      circulation.total += w.total;
      circulation.available += w.available;
      circulation.pending_withdrawals += w.pending;
      if (w.total !== 0) circulation.wallets++;
    }

    const sum = (type: string) => {
      const rows = completed.filter((t) => t.type === type);
      return { count: rows.length, amount: round2(rows.reduce((a, t) => a + Number(t.amount), 0)) };
    };

    // Each fee splits at the rates it was settled under; older rows use the agent's current rates.
    const byAgent = new Map<string, TxRow[]>();
    for (const t of completed) if (t.agent_id) byAgent.set(t.agent_id, [...(byAgent.get(t.agent_id) ?? []), t]);
    const fallback = await fallbackRatesFor(byAgent);

    const fees = { total: 0, platform: 0, tax: 0, agents_net: 0 };
    for (const t of completed) {
      if (!t.agent_id) continue;
      const f = Number(t.fees ?? 0);
      const s = splitTxFee(t, fallback.get(t.agent_id));
      fees.total += f;
      fees.platform += s.platform;
      fees.tax += s.tax;
      fees.agents_net += s.net;
    }

    const agentCash = { owed_to_blink: 0, credit: 0, agents_owing: 0, agents: agentIds.length };
    for (const d of agentDues.values()) {
      agentCash.owed_to_blink += d.total_dues;
      agentCash.credit += d.credit;
      if (d.total_dues > 0) agentCash.agents_owing++;
    }

    return c.json(
      {
        window_days: days,
        generated_at: now.toISOString(),
        circulation: {
          total: round2(circulation.total),
          available: round2(circulation.available),
          pending_withdrawals: round2(circulation.pending_withdrawals),
          wallets: circulation.wallets,
        },
        deposits: sum("deposit"),
        withdrawals: sum("withdrawal"),
        fees: {
          total: round2(fees.total),
          platform: round2(fees.platform),
          tax: round2(fees.tax),
          agents_net: round2(fees.agents_net),
        },
        pending: {
          count: pending.length,
          amount: round2(pending.reduce((a, t) => a + Number(t.amount), 0)),
        },
        agent_cash: {
          owed_to_blink: round2(agentCash.owed_to_blink),
          credit: round2(agentCash.credit),
          agents_owing: agentCash.agents_owing,
          agents: agentCash.agents,
        },
        daily: bucketDaily(completed, days, now),
      },
      200
    );
  }
);

export default app;
