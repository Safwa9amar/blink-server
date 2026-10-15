// Agent Blink Cash economics — dues (cash the agent owes Blink) and earnings.
//
// Riders pay a 2% fee on every deposit / withdrawal an agent processes
// (transactions.fees). Blink keeps a platform share of each fee and withholds
// tax on the rest; the agent keeps the net. The cash side settles via dues:
//   deposit    — the rider handed over `amount + fees` and Blink credited
//                their wallet `amount` → the agent owes `amount + platform + tax`.
//   withdrawal — the agent paid out `amount − fees` and Blink debited the
//                rider `amount` → Blink owes the agent `amount − platform − tax`.
// Won challenge rewards are credited against dues; dues payments settle them.
// A negative balance is a credit (overpayment, or Blink owing the agent).
import { supabaseAdmin } from "./supabase";

/** Blink's share of each rider fee. */
export const AGENT_PLATFORM_FEE_RATE = 0.2;
/** Withholding tax on the agent's share of each fee. */
export const AGENT_TAX_RATE = 0.01;
/** Processing fee charged on top of a dues payment. */
export const AGENT_DUES_FEE_RATE = 0.002;

export const round2 = (n: number) => Math.round(n * 100) / 100;

type Row = Record<string, any>;

/** Split a rider fee into Blink's platform share, tax withheld and the agent's net. */
export function splitFee(fees: number) {
  const platform = round2(fees * AGENT_PLATFORM_FEE_RATE);
  const tax = round2((fees - platform) * AGENT_TAX_RATE);
  return { platform, tax, net: round2(fees - platform - tax) };
}

export interface AgentDues {
  total_dues: number;
  credit: number;
  breakdown: {
    deposits: number;
    withdrawals: number;
    platform_fees: number;
    taxes: number;
    challenge_rewards: number;
    payments: number;
  };
}

export interface DuesTxRow {
  type: string;
  amount: number | string | null;
  fees?: number | string | null;
}

/**
 * The dues math, shared by `computeAgentDues` (one agent) and
 * `computeAgentDuesBatch` (many) so the two can never drift. `txs` must be the
 * agent's COMPLETED operations, `rewards` the reward_amount of won challenges
 * and `payments` the amount of COMPLETED dues payments.
 */
export function agentDuesFromRows(
  txs: readonly DuesTxRow[],
  rewards: readonly { reward_amount: number | string | null }[],
  payments: readonly { amount: number | string | null }[]
): AgentDues {
  const b = { deposits: 0, withdrawals: 0, platform_fees: 0, taxes: 0, challenge_rewards: 0, payments: 0 };
  for (const t of txs) {
    const { platform, tax } = splitFee(Number(t.fees ?? 0));
    if (t.type === "deposit") b.deposits += Number(t.amount);
    else b.withdrawals += Number(t.amount);
    b.platform_fees += platform;
    b.taxes += tax;
  }
  for (const r of rewards) b.challenge_rewards += Number(r.reward_amount ?? 0);
  for (const p of payments) b.payments += Number(p.amount);

  const balance =
    b.deposits - b.withdrawals + b.platform_fees + b.taxes - b.challenge_rewards - b.payments;
  return {
    total_dues: round2(Math.max(0, balance)),
    credit: round2(Math.max(0, -balance)),
    breakdown: {
      deposits: round2(b.deposits),
      withdrawals: round2(b.withdrawals),
      platform_fees: round2(b.platform_fees),
      taxes: round2(b.taxes),
      challenge_rewards: round2(b.challenge_rewards),
      payments: round2(b.payments),
    },
  };
}

/** Outstanding dues for an agent, derived from every completed operation. */
export async function computeAgentDues(agentId: string): Promise<AgentDues> {
  const [{ data: txs }, { data: rewards }, { data: payments }] = await Promise.all([
    supabaseAdmin
      .from("transactions")
      .select("type, amount, fees")
      .eq("agent_id", agentId)
      .eq("status", "completed"),
    supabaseAdmin
      .from("agent_challenge_participants")
      .select("reward_amount")
      .eq("agent_id", agentId)
      .eq("status", "won"),
    supabaseAdmin
      .from("agent_dues_payments")
      .select("amount")
      .eq("agent_id", agentId)
      .eq("status", "completed"),
  ]);
  return agentDuesFromRows(txs ?? [], rewards ?? [], payments ?? []);
}

/** Every row of a query, paged past PostgREST's default 1000-row cap. */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<T[]> {
  const size = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`[agent-finance] read failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data?.length ?? 0) < size) return out;
  }
}

const chunks = <T>(xs: readonly T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const pushTo = <T>(m: Map<string, T[]>, k: string | null | undefined, v: T) => {
  if (!k) return;
  const a = m.get(k);
  if (a) a.push(v);
  else m.set(k, [v]);
};

export interface AgentLedgerTx extends DuesTxRow {
  id: string;
  created_at: string;
  rating: number | null;
}

/** The raw rows behind every agent's dues, grouped by agent (batched reads). */
export async function loadAgentLedgers(agentIds: readonly string[]) {
  const txs = new Map<string, AgentLedgerTx[]>();
  const rewards = new Map<string, { reward_amount: number | string | null }[]>();
  const payments = new Map<string, { amount: number | string | null; created_at: string }[]>();
  for (const ids of chunks([...new Set(agentIds)], 100)) {
    const [t, r, p] = await Promise.all([
      fetchAllRows<AgentLedgerTx & { agent_id: string }>((from, to) =>
        supabaseAdmin
          .from("transactions")
          .select("id, agent_id, type, amount, fees, created_at, rating")
          .in("agent_id", ids)
          .eq("status", "completed")
          .order("id")
          .range(from, to) as any
      ),
      fetchAllRows<{ agent_id: string; reward_amount: number | null }>((from, to) =>
        supabaseAdmin
          .from("agent_challenge_participants")
          .select("agent_id, reward_amount")
          .in("agent_id", ids)
          .eq("status", "won")
          .order("agent_id")
          .range(from, to) as any
      ),
      fetchAllRows<{ id: string; agent_id: string; amount: number; created_at: string }>((from, to) =>
        supabaseAdmin
          .from("agent_dues_payments")
          .select("id, agent_id, amount, created_at")
          .in("agent_id", ids)
          .eq("status", "completed")
          .order("id")
          .range(from, to) as any
      ),
    ]);
    for (const x of t) pushTo(txs, x.agent_id, x);
    for (const x of r) pushTo(rewards, x.agent_id, x);
    for (const x of p) pushTo(payments, x.agent_id, x);
  }
  return { txs, rewards, payments };
}

/** `computeAgentDues` for many agents at once — one batched read per table. */
export async function computeAgentDuesBatch(agentIds: readonly string[]): Promise<Map<string, AgentDues>> {
  const { txs, rewards, payments } = await loadAgentLedgers(agentIds);
  return new Map(
    [...new Set(agentIds)].map((id) => [
      id,
      agentDuesFromRows(txs.get(id) ?? [], rewards.get(id) ?? [], payments.get(id) ?? []),
    ])
  );
}

/** Every agent: users with an agent_profiles row plus any owner of an agent shop. */
export async function listAgentIds(): Promise<string[]> {
  const [profiles, shops] = await Promise.all([
    fetchAllRows<{ user_id: string }>((from, to) =>
      supabaseAdmin.from("agent_profiles").select("user_id").order("user_id").range(from, to) as any
    ),
    fetchAllRows<{ user_id: string }>((from, to) =>
      supabaseAdmin.from("agent_shops").select("user_id").order("id").range(from, to) as any
    ),
  ]);
  return [...new Set([...profiles, ...shops].map((r) => r.user_id))];
}

export interface AgentOperation {
  id: string;
  type: "deposit" | "withdrawal" | "challenge_bonus";
  status: "completed" | "pending" | "cancelled";
  /** What the agent earns: the fee for an operation, the reward for a bonus. */
  amount: number;
  /** Cash amount of the operation (reward for a bonus). */
  volume: number;
  title: string | null;
  created_at: string;
}

/** Agent earnings for [start, end): fee income, bonuses, deductions, operations. */
export async function computeAgentEarnings(agentId: string, start: Date, end: Date) {
  const from = start.toISOString();
  const to = end.toISOString();
  const [{ data: txs }, { data: wins }] = await Promise.all([
    supabaseAdmin
      .from("transactions")
      .select("id, type, amount, fees, total, status, created_at")
      .eq("agent_id", agentId)
      .gte("created_at", from)
      .lt("created_at", to)
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("agent_challenge_participants")
      .select("challenge_id, reward_amount, settled_at, agent_challenges(title)")
      .eq("agent_id", agentId)
      .eq("status", "won")
      .gte("settled_at", from)
      .lt("settled_at", to),
  ]);

  let incomeDeposits = 0;
  let incomeWithdrawals = 0;
  let platform = 0;
  let tax = 0;
  let depositsCount = 0;
  let withdrawalsCount = 0;
  const operations: AgentOperation[] = [];

  for (const t of (txs ?? []) as Row[]) {
    const fees = Number(t.fees ?? 0);
    if (t.status === "completed") {
      const split = splitFee(fees);
      platform += split.platform;
      tax += split.tax;
      if (t.type === "deposit") {
        incomeDeposits += fees;
        depositsCount++;
      } else {
        incomeWithdrawals += fees;
        withdrawalsCount++;
      }
    }
    operations.push({
      id: t.id,
      type: t.type,
      status: t.status,
      amount: fees,
      volume: Number(t.amount),
      title: null,
      created_at: t.created_at,
    });
  }

  let bonuses = 0;
  for (const w of (wins ?? []) as Row[]) {
    const reward = Number(w.reward_amount ?? 0);
    bonuses += reward;
    operations.push({
      id: `bonus-${w.challenge_id}`,
      type: "challenge_bonus",
      status: "completed",
      amount: reward,
      volume: reward,
      title: w.agent_challenges?.title ?? null,
      created_at: w.settled_at,
    });
  }
  operations.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const gross = incomeDeposits + incomeWithdrawals + bonuses;
  const deducted = platform + tax;
  return {
    gross_income: round2(gross),
    net_income: round2(gross - deducted),
    income_deposits: round2(incomeDeposits),
    income_withdrawals: round2(incomeWithdrawals),
    challenge_bonuses: round2(bonuses),
    platform_fee: round2(platform),
    tax_withholding: round2(tax),
    total_deducted: round2(deducted),
    deposits_count: depositsCount,
    withdrawals_count: withdrawalsCount,
    operations,
  };
}
