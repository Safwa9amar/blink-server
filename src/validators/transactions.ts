import { z } from "@hono/zod-openapi";
import { transactions } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

export const createDepositSchema = z
  .object({
    amount: z.number().positive("Amount must be positive"),
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(), // required if method is "agent"
  })
  .openapi("CreateDepositBody");

export const createWithdrawalSchema = z
  .object({
    amount: z.number().positive("Amount must be positive"),
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(),
  })
  .openapi("CreateWithdrawalBody");

export const processTransactionSchema = z
  .object({
    transaction_id: z.string().uuid(),
    action: z.enum(["confirm", "cancel"]),
    pin: z.string().length(4).regex(/^\d{4}$/),
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

export const TransactionSchema = rowSchema(transactions, "Transaction");

export const TransactionResponse = z
  .object({ transaction: TransactionSchema })
  .openapi("TransactionResponse");

export const TransactionListResponse = z
  .object({ transactions: z.array(TransactionSchema), pagination: PaginationSchema })
  .openapi("TransactionListResponse");
