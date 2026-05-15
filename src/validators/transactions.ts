import { z } from "zod";

export const createDepositSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  method: z.enum(["electronic", "agent"]),
  agent_id: z.string().uuid().optional(), // required if method is "agent"
});

export const createWithdrawalSchema = z.object({
  amount: z.number().positive("Amount must be positive"),
  method: z.enum(["electronic", "agent"]),
  agent_id: z.string().uuid().optional(),
});

export const processTransactionSchema = z.object({
  transaction_id: z.string().uuid(),
  action: z.enum(["confirm", "cancel"]),
  pin: z.string().length(4).regex(/^\d{4}$/),
});

export const scanQrSchema = z.object({
  qr_data: z.string().min(1, "QR data is required"),
});

export const rateTransactionSchema = z.object({
  rating: z.number().int().min(1).max(5),
  feedback: z.string().max(500).optional(),
});

export const listTransactionsSchema = z.object({
  type: z.enum(["deposit", "withdrawal"]).optional(),
  status: z.enum(["completed", "cancelled", "pending"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});
