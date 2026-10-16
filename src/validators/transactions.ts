import { z } from "@hono/zod-openapi";
import { transactions } from "../db/schema";
import { AGENT_ACCESS_CODES } from "../lib/agent-access";
import { PaginationSchema, rowSchema } from "../openapi";

const clientRef = z
  .string()
  .uuid()
  .optional()
  .openapi({ description: "Idempotency key: a retry with the same value returns the first request (200) instead of creating another" });

export const createDepositSchema = z
  .object({
    amount: z.number().positive("Amount must be positive"),
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(), // required if method is "agent"
    shop_id: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "Agent shop the rider chose; its owner becomes agent_id" }),
    client_ref: clientRef,
    offer_id: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "Deposit offer (GET /blink-cash/offers) whose bonus this deposit earns when completed" }),
    reference: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .openapi({ description: "Electronic only: the payment reference of the transfer (required)" }),
    receipt_url: z.string().url().max(500).optional().openapi({ description: "Electronic only: photo of the receipt" }),
  })
  .openapi("CreateDepositBody");

export const payoutAccountSchema = z
  .object({
    type: z.enum(["ccp", "baridimob", "rip", "bank"]),
    number: z.string().trim().min(1).max(60),
    holder: z.string().trim().min(1).max(120),
  })
  .openapi("PayoutAccount");

export const createWithdrawalSchema = z
  .object({
    amount: z.number().positive("Amount must be positive"),
    method: z.enum(["electronic", "agent"]),
    agent_id: z.string().uuid().optional(),
    shop_id: z
      .string()
      .uuid()
      .optional()
      .openapi({ description: "Agent shop the rider chose; its owner becomes agent_id" }),
    client_ref: clientRef,
    pin: z
      .string()
      .regex(/^\d{4}$/)
      .optional()
      .openapi({ description: "The rider's PIN; required when blink_cash_settings.require_pin_for_withdrawal is on" }),
    payout_account: payoutAccountSchema
      .optional()
      .openapi({ description: "Electronic only: where Blink pays the money out (required)" }),
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
  status: z.enum(["completed", "cancelled", "pending", "review", "reversed"]).optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

// ─── Response schemas ────────────────────────────────────────────────

export const TransactionSchema = rowSchema(transactions, "Transaction", {
  payout_account: payoutAccountSchema.nullable(),
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
    code: z.enum([...AGENT_ACCESS_CODES, "pin_locked", "wrong_agent", "wallet_frozen"]).optional(),
    /** pin_locked: seconds until the PIN unlocks. */
    retry_after: z.number().optional(),
  })
  .openapi("AgentAccessError");

/** The 400 of a create: `code` says which rule refused it. */
export const CashRequestError = z
  .object({
    error: z.string(),
    code: z
      .enum([
        "electronic_unavailable",
        "limit_min",
        "limit_max",
        "limit_daily",
        "limit_monthly",
        "insufficient_funds",
        "pin_required",
        "reference_required",
        "payout_account_required",
        "offer_inactive",
        "offer_not_started",
        "offer_ended",
        "offer_min_deposit",
        "offer_limit_reached",
        "offer_budget_exhausted",
      ])
      .optional(),
    /** limit_*: the limit that was hit… */
    limit: z.number().optional(),
    /** …and what the rider already used of it. */
    used: z.number().optional(),
  })
  .openapi("CashRequestError");

/** A 403 of a PIN check: no code = wrong PIN, `pin_locked` adds `retry_after` (seconds). */
export const PinError = z
  .object({
    error: z.string(),
    code: z.literal("pin_locked").optional(),
    retry_after: z.number().optional(),
  })
  .openapi("PinError");

/** A failure of the Blink Cash money functions (409 / 410 / 403). */
export const WalletFunctionError = z
  .object({
    error: z.string(),
    code: z
      .enum([
        "insufficient_funds",
        "wallet_frozen",
        "not_pending",
        "expired",
        "wrong_agent",
        "not_found",
        "not_completed",
        "not_in_review",
        "agent_limit_reached",
      ])
      .optional(),
    limit: z.number().optional(),
    total_dues: z.number().optional(),
  })
  .openapi("WalletFunctionError");
