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
import { normalizeWilaya, wilayaAt } from "./geo/wilaya";
import { getPrices } from "./pricing";
import { userWilaya } from "./pricing/fees";
import { ratesOf, round2, splitFee, type FeeRates } from "./agent-split";
import { supabaseAdmin } from "./supabase";

// The rates (Blink's platform share, withholding tax, dues payment fee) are
// configurable (src/lib/pricing). Each processed transaction snapshots the
// share + tax it was settled under (transactions.platform_share_rate / tax_rate);
// only older rows without one use the agent's currently resolved rates.

type Row = Record<string, any>;
export { round2, splitFee, ratesOf, type FeeRates };

/**
 * The agent's wilaya for pricing: their shop's (address text, else its
 * coordinates), else the agent's own profile wilaya.
 */
export async function agentWilaya(agentId: string, shop?: Row | null): Promise<string | null> {
  let s = shop;
  if (s === undefined) {
    const { data } = await supabaseAdmin
      .from("agent_shops")
      .select("address, latitude, longitude")
      .eq("user_id", agentId)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    s = data;
  }
  const lat = Number(s?.latitude ?? 0);
  const lng = Number(s?.longitude ?? 0);
  return (
    normalizeWilaya(s?.address) ??
    (lat !== 0 || lng !== 0 ? wilayaAt(lat, lng) : null) ??
    (await userWilaya(agentId))
  );
}

/** The platform share + tax now in force for an agent (and which deals set them). */
export async function resolveAgentRates(agentId: string, shop?: Row | null) {
  const wilaya = await agentWilaya(agentId, shop);
  const p = await getPrices(["agent_platform_share", "agent_tax_rate"] as const, { agentId, wilaya });
  return {
    platform: p.agent_platform_share.value.rate,
    tax: p.agent_tax_rate.value.rate,
    applied: {
      agent_platform_share: p.agent_platform_share.overrideId,
      agent_tax_rate: p.agent_tax_rate.overrideId,
    },
  };
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
  /** Rates the operation was settled under (null on rows older than the snapshot). */
  platform_share_rate?: number | string | null;
  tax_rate?: number | string | null;
}

const lacksSnapshot = (t: Record<string, any>) => t.platform_share_rate == null || t.tax_rate == null;

/**
 * Split one operation's fee with the rates it was settled under. A row older
 * than the rate snapshot needs the agent's current rates (`fallback`); without
 * them this throws rather than guess money.
 */
export function splitTxFee(t: Record<string, any>, fallback?: FeeRates) {
  if (!fallback && lacksSnapshot(t)) {
    throw new Error("[agent-finance] an operation without a rate snapshot needs the agent's current rates");
  }
  return splitFee(Number(t.fees ?? 0), ratesOf(t, fallback ?? { platform: 0, tax: 0 }));
}

/**
 * Current rates for each agent that still has operations without a rate
 * snapshot (the only rows that use them), resolved a few agents at a time.
 * `shopOf` saves the shop lookup when the caller already has the agent's shop.
 */
export async function fallbackRatesFor(
  txsByAgent: ReadonlyMap<string, readonly Record<string, any>[]>,
  shopOf?: (agentId: string) => Row | null | undefined
): Promise<Map<string, FeeRates>> {
  const ids = [...txsByAgent].filter(([, txs]) => txs.some(lacksSnapshot)).map(([id]) => id);
  const out = new Map<string, FeeRates>();
  for (let i = 0; i < ids.length; i += 8) {
    const slice = ids.slice(i, i + 8);
    const rates = await Promise.all(slice.map((id) => resolveAgentRates(id, shopOf?.(id))));
    slice.forEach((id, j) => out.set(id, { platform: rates[j].platform, tax: rates[j].tax }));
  }
  return out;
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
  payments: readonly { amount: number | string | null }[],
  /** The agent's current rates, for operations older than the rate snapshot. */
  fallback?: FeeRates
): AgentDues {
  const b = { deposits: 0, withdrawals: 0, platform_fees: 0, taxes: 0, challenge_rewards: 0, payments: 0 };
  for (const t of txs) {
    const { platform, tax } = splitTxFee(t, fallback);
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
export async function computeAgentDues(
  agentId: string,
  /** Pass the already-resolved rates to avoid resolving them twice. */
  rates?: Awaited<ReturnType<typeof resolveAgentRates>>
): Promise<AgentDues> {
  const [txsRes, rewardsRes, paymentsRes, current] = await Promise.all([
    supabaseAdmin
      .from("transactions")
      .select("type, amount, fees, platform_share_rate, tax_rate")
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
    rates ?? resolveAgentRates(agentId),
  ]);
  // Never report zero dues because a read failed.
  for (const r of [txsRes, rewardsRes, paymentsRes]) {
    if (r.error) throw new Error(`[agent-finance] dues read failed: ${r.error.message}`);
  }
  return agentDuesFromRows(txsRes.data ?? [], rewardsRes.data ?? [], paymentsRes.data ?? [], current);
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
          .select("id, agent_id, type, amount, fees, platform_share_rate, tax_rate, created_at, rating")
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
  const fallback = await fallbackRatesFor(txs);
  return new Map(
    [...new Set(agentIds)].map((id) => [
      id,
      agentDuesFromRows(txs.get(id) ?? [], rewards.get(id) ?? [], payments.get(id) ?? [], fallback.get(id)),
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
  const current = await resolveAgentRates(agentId);
  const [txsRes, winsRes] = await Promise.all([
    supabaseAdmin
      .from("transactions")
      .select("id, type, amount, fees, total, status, created_at, platform_share_rate, tax_rate")
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
  for (const r of [txsRes, winsRes]) {
    if (r.error) throw new Error(`[agent-finance] earnings read failed: ${r.error.message}`);
  }
  const txs = txsRes.data;
  const wins = winsRes.data;

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
      const split = splitFee(fees, ratesOf(t, current));
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
    platform_fee_rate: current.platform,
    tax_rate: current.tax,
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
