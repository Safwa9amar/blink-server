// Multi-store checkout ("bundle") rules, kept pure so they're unit-testable
// without a database (see bundle.test.ts). A bundle is every order sharing a
// `checkout_id`; ONE rider collects from all its stores and makes one
// drop-off. dispatch.ts / routes load the rows and apply these rules.

import { answersRequest, isHeldForOtherRider, isOfferedTo, isRequestVisibleTo } from "./rider-offer";

/** A store that hasn't answered within this window becomes a shopper order. */
export const BUNDLE_STORE_TIMEOUT_MS = 10 * 60 * 1000;

export type BundleRow = Record<string, any>;

/** Rejected / canceled stores drop out of the bundle (refunded separately). */
export const isBundleMember = (o: BundleRow) =>
  o.status !== "canceled" && o.status !== "merchant_rejected";

export const bundleMembers = (rows: BundleRow[]) => rows.filter(isBundleMember);

/** The member that names the job: largest subtotal, ties → smallest id. */
export function leadOrder(members: BundleRow[]): BundleRow {
  return [...members].sort(
    (a, b) => Number(b.subtotal ?? 0) - Number(a.subtotal ?? 0) || String(a.id).localeCompare(String(b.id))
  )[0];
}

/** Ready for a rider: every store accepted (or a rider shops it), nobody holds it yet. */
export function isBundleOfferable(rows: BundleRow[]): boolean {
  const members = bundleMembers(rows);
  return (
    members.length > 0 &&
    members.every(
      (o) =>
        !o.rider_id &&
        o.status === "searching" &&
        (o.type === "shopper" ||
          (["accepted", "ready"].includes(o.merchant_status ?? "") && o.delivery_mode !== "own"))
    )
  );
}

const PROGRESS: Record<string, number> = {
  searching: 0,
  heading_to_store: 1,
  preparation: 2,
  pickup: 2,
  on_the_way: 3,
  delivered: 4,
};

/** The job's status: the least advanced member (delivered only when all are). */
export function bundleStatus(members: BundleRow[]): string {
  if (!members.length) return "canceled";
  return members.reduce((least, o) =>
    (PROGRESS[o.status] ?? 0) < (PROGRESS[least.status] ?? 0) ? o : least
  ).status;
}

/** One drop-off once every store's order is on board. */
export const canDeliverBundle = (members: BundleRow[]) =>
  members.length > 0 && members.every((o) => o.status === "on_the_way");

/** A rider may drop the bundle only before the first pickup. */
export const canCancelBundle = (members: BundleRow[]) =>
  members.length > 0 && members.every((o) => o.status !== "on_the_way" && o.status !== "delivered");

/** The all-or-nothing claim succeeded. */
export const bundleClaimComplete = (claimed: number, members: number) =>
  members > 0 && claimed === members;

/** A checkout store still pending (not canceled) past the timeout. */
export function isStoreTimedOut(o: BundleRow, now = Date.now()): boolean {
  return (
    !!o.checkout_id &&
    o.merchant_status === "pending" &&
    o.status === "processing" &&
    now - new Date(o.created_at).getTime() > BUNDLE_STORE_TIMEOUT_MS
  );
}

// ─── A merchant's own driver for a checkout across their stores ─────
// Ownership (every store is the merchant's) is checked by the route; these
// rules cover the members' state. The request lives on EVERY member with one
// shared offered_at, so it's one request only while all members carry it.

/** The merchant may send its own driver: every member accepted/ready, unassigned, a store order. */
export function canAssignOwnDriver(members: BundleRow[]): boolean {
  return (
    members.length > 0 &&
    members.every(
      (o) =>
        o.type === "merchant" &&
        !o.rider_id &&
        o.status === "searching" &&
        ["accepted", "ready"].includes(o.merchant_status ?? "")
    )
  );
}

const oneRequest = (members: BundleRow[]) =>
  members.length > 0 &&
  members.every(
    (m) => m.offered_rider_id === members[0].offered_rider_id && m.offered_at === members[0].offered_at
  );

/** Shown to the requested driver as one job. */
export const bundleRequestVisibleTo = (members: BundleRow[], riderId: string, now = Date.now()) =>
  oneRequest(members) && members.every((m) => isRequestVisibleTo(m, riderId, now));

/** The requested driver may still accept (TTL + grace). */
export const bundleOfferedTo = (members: BundleRow[], riderId: string, now = Date.now()) =>
  oneRequest(members) && members.every((m) => isOfferedTo(m, riderId, now));

/** The answer names the request the driver was shown (by its deadline). */
export const bundleAnswersRequest = (
  members: BundleRow[],
  riderId: string,
  shown: string,
  now = Date.now()
) => oneRequest(members) && members.every((m) => answersRequest(m, riderId, shown, now));

/** Reserved for another driver: not claimable from the pool. */
export const bundleHeldForOtherRider = (members: BundleRow[], riderId: string, now = Date.now()) =>
  members.some((m) => isHeldForOtherRider(m, riderId, now));

type Point = { lat: number | null; lng: number | null };

const hasPoint = (p: Point | null | undefined): p is { lat: number; lng: number } =>
  !!p && p.lat != null && p.lng != null;

/** Great-circle distance in km. */
function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/**
 * Route order for the stops: already-picked stops first (in pickup order),
 * then nearest-neighbour from the last pickup — or from `from` (the rider)
 * before any pickup, or from the first stop when neither is known. Stops
 * without coordinates go last.
 */
export function orderStops<T extends Point & { picked_up_at?: string | null }>(stops: T[], from: Point | null): T[] {
  const picked = stops
    .filter((s) => s.picked_up_at)
    .sort((a, b) => String(a.picked_up_at).localeCompare(String(b.picked_up_at)));
  const rest = stops.filter((s) => !s.picked_up_at);
  const located = rest.filter(hasPoint);
  const unlocated = rest.filter((s) => !hasPoint(s));

  const route: T[] = [];
  let cursor: Point | null = picked.length ? picked[picked.length - 1] : from;
  if (!hasPoint(cursor) && located.length) cursor = located[0];
  while (located.length) {
    const here = cursor as { lat: number; lng: number };
    let best = 0;
    for (let i = 1; i < located.length; i++) {
      if (km(here, located[i] as any) < km(here, located[best] as any)) best = i;
    }
    const [next] = located.splice(best, 1);
    route.push(next);
    cursor = next;
  }
  return [...picked, ...route, ...unlocated];
}
