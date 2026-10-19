import { z } from "@hono/zod-openapi";
import { transactions } from "../db/schema";
import { AGENT_ACCESS_CODES } from "../lib/agent-access";
import { PaginationSchema, rowSchema } from "../openapi";

// DB money columns are numeric(10,2); a chosen amount stays well under that.
const cashAmount = z.number().positive("Amount must be positive").max(10_000_000, "Amount is too large");

export const createDepositSchema = z
  .object({
    amount: cashAmount,
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(), // required if method is "agent"
    shop_id: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "Agent shop the rider chose; its owner becomes agent_id" }),
  })
  .openapi("CreateDepositBody");

export const createWithdrawalSchema = z
  .object({
    amount: cashAmount,
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(),
    shop_id: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "Agent shop the rider chose; its owner becomes agent_id" }),
  })
  .openapi("CreateWithdrawalBody");

export const setTransactionShopSchema = z
  .object({
    shop_id: z
      .string()
      .uuid()
      .openapi({ description: "Agent shop the rider picked; its owner becomes agent_id" }),
  })
  .openapi("SetTransactionShopBody");

export const processTransactionSchema = z
  .object({
    transaction_id: z.string().uuid(),
    action: z.enum(["confirm", "cancel"]),
    pin: z.string().length(4).regex(/^\d{4}$/),
    /** Agent shop the operation goes through; defaults to the primary shop. */
    shop_id: z.string().uuid().optional(),
  })
  .openapi("ProcessTransactionBody");

export const scanQrSchema = z
  .object({
    qr_data: z.string().min(1, "QR data is required"),
  })
  .openapi("ScanQrBody");

export const rateTransactionSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    feedback: z.string().max(500).optional(),
  })
  .openapi("RateTransactionBody");

export const listTransactionsSchema = z.object({
  type: z.enum(["deposit", "withdrawal"]).optional(),
  status: z.enum(["completed", "cancelled", "pending"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// ─── Response schemas ────────────────────────────────────────────────

export const TransactionSchema = rowSchema(transactions, "Transaction", {
  /** The rider served — embedded on agent-facing reads (inline: OpenAPI 3.0
   *  drops `nullable` beside a $ref, so it's optional, never null). */
  rider: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      phone_number: z.string().nullable(),
      profile_picture: z.string().nullable(),
      display_id: z.string().nullable(),
    })
    .optional(),
});

export const TransactionResponse = z
  .object({ transaction: TransactionSchema })
  .openapi("TransactionResponse");

export const TransactionListResponse = z
  .object({ transactions: z.array(TransactionSchema), pagination: PaginationSchema })
  .openapi("TransactionListResponse");

/**
 * 403 of POST /transactions/scan-qr and /transactions/process.
 * `code: shop_not_approved` — the agent's processing shop isn't staff-approved
 * (agent_shops.review_status ≠ active) or they have no shop.
 * `code: not_your_transaction` — the rider sent the operation to another agent.
 * A 403 without `code`: wrong PIN (/process) or the caller isn't an agent.
 */
export const AgentAccessError = z
  .object({
    error: z.string(),
    code: z.enum(AGENT_ACCESS_CODES).optional(),
  })
  .openapi("AgentAccessError");
