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

/** Partial transaction select used in `recent_operations`. */
export const AgentEarningsOperationSchema = TransactionSchema.pick({
  type: true,
  amount: true,
  fees: true,
  total: true,
  status: true,
  created_at: true,
}).openapi("AgentEarningsOperation");

export const AgentEarningsResponse = z
  .object({
    earnings: z.object({
      net_income: z.number(),
      gross_income: z.number(),
      deposits_count: z.number().int(),
      withdrawals_count: z.number().int(),
      recent_operations: z.array(AgentEarningsOperationSchema),
    }),
  })
  .openapi("AgentEarningsResponse");
