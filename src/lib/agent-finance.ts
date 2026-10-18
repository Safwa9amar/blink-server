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
  const txs = txsRes.data;
  const rewards = rewardsRes.data;
  const payments = paymentsRes.data;

  const b = { deposits: 0, withdrawals: 0, platform_fees: 0, taxes: 0, challenge_rewards: 0, payments: 0 };
  for (const t of txs ?? []) {
    const { platform, tax } = splitFee(Number(t.fees ?? 0), ratesOf(t, current));
    if (t.type === "deposit") b.deposits += Number(t.amount);
    else b.withdrawals += Number(t.amount);
    b.platform_fees += platform;
    b.taxes += tax;
  }
  for (const r of rewards ?? []) b.challenge_rewards += Number(r.reward_amount ?? 0);
  for (const p of payments ?? []) b.payments += Number(p.amount);

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
