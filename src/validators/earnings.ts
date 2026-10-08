import { z } from "@hono/zod-openapi";
import { TransactionSchema } from "./transactions";

// ─── Rider earnings ──────────────────────────────────────────────────

export const RiderEarningsResponse = z
  .object({
    earnings: z.object({
      net_income: z.number(),
      gross_income: z.number(),
      commissions_taxes: z.number(),
      trips_count: z.number().int(),
    }),
  })
  .openapi("RiderEarningsResponse");

// ─── Agent earnings ──────────────────────────────────────────────────

export const agentEarningsQuerySchema = z.object({
  period: z.enum(["today", "this_week", "this_month", "this_year", "custom"]).default("this_month"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

/** Partial transaction select used in `recent_operations`. */
export const AgentEarningsOperationSchema = TransactionSchema.pick({
  type: true,
  amount: true,
  fees: true,
  total: true,
  status: true,
  created_at: true,
}).openapi("AgentEarningsOperation");

/** One line of the operations history: a processed operation or a won bonus. */
export const AgentOperationSchema = z
  .object({
    id: z.string(),
    type: z.enum(["deposit", "withdrawal", "challenge_bonus"]),
    status: z.enum(["completed", "pending", "cancelled"]),
    /** What the agent earns: the fee for an operation, the reward for a bonus. */
    amount: z.number(),
    /** Cash amount of the operation (the reward for a bonus). */
    volume: z.number(),
    /** Challenge title for a bonus. */
    title: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("AgentOperation");

export const AgentEarningsResponse = z
  .object({
    earnings: z.object({
      period_start: z.string(),
      period_end: z.string(),
      /** Gross income minus platform fee and tax withholding. */
      net_income: z.number(),
      /** Fee income from deposits + withdrawals, plus challenge bonuses. */
      gross_income: z.number(),
      income_deposits: z.number(),
      income_withdrawals: z.number(),
      challenge_bonuses: z.number(),
      platform_fee: z.number(),
      tax_withholding: z.number(),
      total_deducted: z.number(),
      platform_fee_rate: z.number(),
      tax_rate: z.number(),
      deposits_count: z.number().int(),
      withdrawals_count: z.number().int(),
      /** Latest operations in the period (legacy shape). */
      recent_operations: z.array(AgentEarningsOperationSchema),
      /** Operations + bonuses in the period, newest first. */
      operations: z.array(AgentOperationSchema),
    }),
  })
  .openapi("AgentEarningsResponse");
