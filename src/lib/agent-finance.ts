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

  const b = { deposits: 0, withdrawals: 0, platform_fees: 0, taxes: 0, challenge_rewards: 0, payments: 0 };
  for (const t of txs ?? []) {
    const { platform, tax } = splitFee(Number(t.fees ?? 0));
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
