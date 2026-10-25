// Row -> API view mappers shared by the payments routes.
import { z } from "../../openapi";

type Row = Record<string, any>;

export const PaymentIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }),
});

/** The `Payment` schema from a payments row (checkout_url only while pending). */
export function toPayment(p: Row) {
  return {
    id: p.id as string,
    purpose: p.purpose,
    ref_id: p.ref_id as string,
    provider: p.provider,
    method: p.method as string,
    amount: Number(p.amount),
    currency: p.currency as string,
    base_amount: p.metadata?.base_amount != null ? Number(p.metadata.base_amount) : null,
    status: p.status,
    failure_reason: (p.failure_reason ?? null) as string | null,
    paid_at: (p.paid_at ?? null) as string | null,
    expires_at: (p.expires_at ?? null) as string | null,
    created_at: p.created_at as string,
    checkout_url: p.status === "pending" ? ((p.checkout_url ?? null) as string | null) : null,
    test_mode: !p.livemode,
  };
}
