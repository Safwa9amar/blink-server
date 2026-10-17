// The customer service fee is decided here, never taken from the client.
// 1.50 DZD per checkout: a multi-store checkout is created as one order per
// store sharing a checkout_id, and the fee rides on only one of them.

/** Service fee (DZD) charged once per store checkout. Mirrors the app's SERVICE_FEE. */
export const SERVICE_FEE = 1.5;

/**
 * The service fee for a new order. Courier / ride orders never carry one.
 * Any other (store) order carries it unless another order of the same checkout already
 * does (`checkoutAlreadyCharged`), so the first one created in a checkout is
 * the one that pays it.
 */
export function serviceFeeFor(order: { type: string; checkoutAlreadyCharged: boolean }): number {
  if (order.type === "courier" || order.type === "ride") return 0;
  return order.checkoutAlreadyCharged ? 0 : SERVICE_FEE;
}
