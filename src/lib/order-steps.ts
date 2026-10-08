// Order lifecycle writes shared by the rider and merchant routes, kept pure so
// they're unit-testable without a database (see order-steps.test.ts).

type Row = Record<string, any>;

/**
 * The order leaves the store with its rider (→ on_the_way). A store order
 * collected before the store tapped "Mark as prepared" is prepared by then —
 * the bag is on board — so it's marked ready too; otherwise the merchant
 * screen would stay on "Preparing" while customer and rider show it on the way.
 */
export function pickedUpPatch(o: Row, nowIso: string) {
  return {
    status: "on_the_way" as const,
    picked_up_at: nowIso,
    ...(o.type === "merchant" && o.merchant_status === "accepted"
      ? { merchant_status: "ready" as const, prepared_at: nowIso }
      : {}),
  };
}
