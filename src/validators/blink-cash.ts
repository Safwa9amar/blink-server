import { z } from "@hono/zod-openapi";

const count = z.object({ count: z.number(), amount: z.number() });

export const AdminBlinkCashSummaryQuery = z.object({
  days: z
    .enum(["7", "30", "90"])
    .optional()
    .openapi({ description: "Window in days (default 30)", param: { name: "days", in: "query" } }),
});

export const AdminBlinkCashSummaryResponse = z
  .object({
    window_days: z.number(),
    generated_at: z.string(),
    /** Σ rider wallets (riderWallet) across every rider. */
    circulation: z.object({
      total: z.number(),
      available: z.number(),
      pending_withdrawals: z.number(),
      /** Riders whose wallet total is not 0. */
      wallets: z.number(),
    }),
    /** Completed in the window. */
    deposits: count,
    withdrawals: count,
    /** splitFee over completed agent operations in the window. */
    fees: z.object({ total: z.number(), platform: z.number(), tax: z.number(), agents_net: z.number() }),
    /** Currently pending, any age. */
    pending: count,
    /** Σ agent dues, all time. */
    agent_cash: z.object({
      owed_to_blink: z.number(),
      credit: z.number(),
      agents_owing: z.number(),
      agents: z.number(),
    }),
    /** Africa/Algiers calendar days, every day of the window (zeros included). */
    daily: z.array(
      z.object({
        date: z.string(),
        deposits: z.number(),
        withdrawals: z.number(),
        deposits_count: z.number(),
        withdrawals_count: z.number(),
      })
    ),
  })
  .openapi("AdminBlinkCashSummary");

export const AdminAgentDuesResponse = z
  .object({
    agents: z.array(
      z
        .object({
          agent_id: z.string(),
          name: z.string().nullable(),
          phone: z.string().nullable(),
          shops_total: z.number(),
          shops_open: z.number(),
          primary_shop: z
            .object({
              id: z.string(),
              name: z.string(),
              address: z.string().nullable(),
              lat: z.number().nullable(),
              lng: z.number().nullable(),
            })
            .nullable(),
          /** Completed, all time. */
          deposits: count,
          withdrawals: count,
          operations_30d: z.number(),
          /** The agent's net fees, all time (splitFee().net). */
          fee_income_net: z.number(),
          total_dues: z.number(),
          credit: z.number(),
          last_operation_at: z.string().nullable(),
          last_payment_at: z.string().nullable(),
          rating_avg: z.number().nullable(),
          ratings_count: z.number(),
        })
        .openapi("AdminAgentDues")
    ),
    /** Latest 100 agent dues payments, newest first. */
    payments: z.array(
      z
        .object({
          id: z.string(),
          agent_id: z.string(),
          agent_name: z.string().nullable(),
          amount: z.number(),
          fees: z.number(),
          method: z.string(),
          status: z.string(),
          created_at: z.string(),
        })
        .openapi("AdminAgentDuesPayment")
    ),
  })
  .openapi("AdminAgentDuesResponse");

export const AgentIdParam = z.object({
  agent_id: z.string().uuid().openapi({ param: { name: "agent_id", in: "path" } }),
});

export const AgentDuesReminderError = z
  .object({ error: z.string(), code: z.enum(["nothing_outstanding", "reminded_recently"]) })
  .openapi("AgentDuesReminderError");

export const RemindAgentDuesResponse = z.object({ ok: z.literal(true) }).openapi("RemindAgentDuesResponse");
