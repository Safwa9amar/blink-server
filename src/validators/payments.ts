import { z } from "@hono/zod-openapi";
import { PaginationSchema } from "../openapi";

const provider = z.enum(["chargily", "stripe", "satim"]);
const methodId = z.enum(["edahabia", "cib", "card"]);
const status = z.enum(["pending", "paid", "failed", "canceled", "expired"]);
const purpose = z.enum(["wallet_topup", "agent_dues", "merchant_dues"]);

export const PaymentMethodOption = z
  .object({
    id: methodId,
    provider,
    label: z.string(),
    test_mode: z.boolean(),
    /** The smallest amount, in DZD, this method can pay (the provider's floor); null = none. */
    min_amount: z.number().nullable(),
    /** The currency the card is charged in (DZD, or EUR for Stripe). */
    currency: z.string(),
    /** DZD for one unit of `currency` (Blink's fixed rate); null when it is DZD. */
    dzd_rate: z.number().nullable(),
  })
  .openapi("PaymentMethodOption");

export const PaymentMethodsResponse = z
  .object({ methods: z.array(PaymentMethodOption) })
  .openapi("PaymentMethodsResponse");

/** What a client needs to send the user to the gateway page. */
export const PaymentCheckout = z
  .object({
    payment_id: z.string().uuid(),
    provider,
    method: methodId,
    checkout_url: z.string(),
    /** The server page the provider returns the customer to (redirects into the app). */
    return_url: z.string(),
    expires_at: z.string().nullable(),
  })
  .openapi("PaymentCheckout");

export const Payment = z
  .object({
    id: z.string().uuid(),
    purpose,
    ref_id: z.string().uuid(),
    provider,
    method: z.string(),
    /** What the card is charged, in `currency`. */
    amount: z.number(),
    currency: z.string(),
    /** The dinar amount behind a charge in another currency (EUR); null when `currency` is DZD. */
    base_amount: z.number().nullable(),
    status,
    failure_reason: z.string().nullable(),
    paid_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
    /** Only while pending. */
    checkout_url: z.string().nullable(),
    test_mode: z.boolean(),
  })
  .openapi("Payment");

export const PaymentResponse = z.object({ payment: Payment }).openapi("PaymentResponse");

// ─── Staff ───────────────────────────────────────────────────────────

export const AdminPaymentListQuery = z.object({
  status: status.optional(),
  provider: provider.optional(),
  purpose: purpose.optional(),
  user_id: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

export const AdminPayment = Payment.extend({
  user_id: z.string().uuid(),
  user_name: z.string().nullable(),
  provider_ref: z.string().nullable(),
  last_synced_at: z.string().nullable(),
}).openapi("AdminPayment");

export const AdminPaymentListResponse = z
  .object({ payments: z.array(AdminPayment), pagination: PaginationSchema })
  .openapi("AdminPaymentListResponse");

export const AdminPaymentProvider = z
  .object({
    provider,
    configured: z.boolean(),
    test_mode: z.boolean(),
    methods: z.array(methodId),
    /** The currency the provider charges, and DZD for one unit of it (null when DZD). */
    currency: z.string(),
    dzd_rate: z.number().nullable(),
    /** Where to register the webhook; null when the provider has none (SATIM) or PUBLIC_API_URL is unset. */
    webhook_url: z.string().nullable(),
  })
  .openapi("AdminPaymentProvider");

export const AdminPaymentProvidersResponse = z
  .object({ providers: z.array(AdminPaymentProvider), public_api_url: z.string() })
  .openapi("AdminPaymentProvidersResponse");
