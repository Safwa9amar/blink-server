// Rider offer handshake — a store's request to ONE rider (its own app driver
// or a Blink rider). Kept pure so it's unit-testable without a database (see
// rider-offer.test.ts); routes load the rows and apply these rules.
//
// The request lives on the order (offered_* columns, migration
// 20261007180407_order_rider_offer.sql) while the order stays `searching`
// with no rider_id, so the customer keeps "searching for a rider" and the
// merchant shows "waiting for <rider>". Only the rider's accept assigns the
// order (acceptPatch), so all three apps move forward together.
//
// Timeline of one request (server clock — offered_at is always written with
// the server's Date.now(), never the database's now()):
//   offered_at ──── TTL ────┬── GRACE ──┐
//   live: shown to the rider │ late accept │ released: back to the open pool
//   merchant "pending"       │ still lands │ (merchant: "expired")

/** How long the requested rider has to answer (countdown on both apps). */
export const RIDER_OFFER_TTL_MS = 2 * 60 * 1000;
/**
 * After the TTL the requested rider's accept is still honoured for this long
 * (it covers the 8 s offer poll + network), and other riders are held off.
 */
export const ACCEPT_GRACE_MS = 15 * 1000;
/** A job scheduled further ahead than this is booked, not started (accept). */
export const SCHEDULED_BOOKING_LEAD_MS = 30 * 60 * 1000;

export type OfferMode = "own" | "blink";
export type OfferStatus = "pending" | "declined" | "expired";
type Row = Record<string, any>;

/** Spread into every write that assigns, withdraws or ends a request. */
export const CLEAR_OFFER = {
  offered_rider_id: null,
  offered_driver_id: null,
  offered_mode: null,
  offered_at: null,
  offer_declined_at: null,
} as const;

/**
 * Customer / rider order payloads (/orders/*) don't reveal which rider a
 * store asked: the request columns are returned as null. This masks the API
 * only — the orders RLS select policy still lets a customer read these
 * columns of their own order through PostgREST.
 */
export const withoutOffer = <T extends Row>(o: T): T => ({ ...o, ...CLEAR_OFFER });

const time = (iso: unknown) => (typeof iso === "string" && iso ? new Date(iso).getTime() : NaN);

/** Still waiting for a rider. */
const isUnassigned = (o: Row) => !o.rider_id && o.status === "searching";

/** A request was sent and not declined (it may have expired). */
const isOpen = (o: Row) =>
  !!o.offered_rider_id && Number.isFinite(time(o.offered_at)) && !o.offer_declined_at && isUnassigned(o);

const deadline = (o: Row) => time(o.offered_at) + RIDER_OFFER_TTL_MS;

/** Within the TTL: the rider sees it, the merchant is "waiting". */
export const isLiveOffer = (o: Row, now = Date.now()) => isOpen(o) && now < deadline(o);

/** Within TTL + grace: the order is reserved for the requested rider. */
export const isHeld = (o: Row, now = Date.now()) => isOpen(o) && now < deadline(o) + ACCEPT_GRACE_MS;

/** The requested rider may still accept (targeted claim). */
export const isOfferedTo = (o: Row, riderId: string, now = Date.now()) =>
  isHeld(o, now) && o.offered_rider_id === riderId;

/** Reserved for someone else: hidden from this rider's pool and not claimable. */
export const isHeldForOtherRider = (o: Row, riderId: string, now = Date.now()) =>
  isHeld(o, now) && o.offered_rider_id !== riderId;

/** Shown in the requested rider's offer feed (no grace: the sheet closes at the deadline). */
export const isRequestVisibleTo = (o: Row, riderId: string, now = Date.now()) =>
  isLiveOffer(o, now) && o.offered_rider_id === riderId;

/**
 * The rider's answer names the request they were shown by its deadline
 * (RiderJob.request_expires_at). True only while that exact request is still
 * open to them: a withdrawn, re-sent (new deadline), declined or lapsed one is
 * a different request, so the answer must not apply to it — and must never
 * fall through to an ordinary pool claim.
 */
export const answersRequest = (o: Row, riderId: string, shownDeadline: string, now = Date.now()) =>
  isOfferedTo(o, riderId, now) && Date.parse(shownDeadline) === deadline(o);

/** The answer deadline (ISO) while the request is live, else null. */
export const offerExpiresAt = (o: Row, now = Date.now()) =>
  isLiveOffer(o, now) ? new Date(deadline(o)).toISOString() : null;

/**
 * Lower bounds on offered_at for database filters (`offered_at > …`), the SQL
 * twins of isLiveOffer / isHeld: now < offered_at + TTL ⟺ offered_at > now − TTL.
 */
export const liveSinceIso = (now: number) => new Date(now - RIDER_OFFER_TTL_MS).toISOString();
export const heldSinceIso = (now: number) =>
  new Date(now - RIDER_OFFER_TTL_MS - ACCEPT_GRACE_MS).toISOString();

/**
 * The RiderJob request fields. Only the requested rider sees them, and only
 * while the request is live: request_kind null means an ordinary job.
 */
export function requestFields(o: Row, viewerId: string | undefined, now = Date.now()) {
  const mode = o.offered_mode;
  const kind: OfferMode | null =
    viewerId && isRequestVisibleTo(o, viewerId, now) && (mode === "own" || mode === "blink") ? mode : null;
  return { request_kind: kind, request_expires_at: kind ? offerExpiresAt(o, now) : null };
}

/**
 * The merchant's view of the latest request on an unassigned order. Declined
 * also covers a rider who went offline / took another job before answering.
 */
export function offerStatus(o: Row, now = Date.now()): OfferStatus | null {
  if (!o.offered_rider_id || !isUnassigned(o)) return null;
  if (o.offer_declined_at) return "declined";
  return isLiveOffer(o, now) ? "pending" : "expired";
}

export const isScheduledBooking = (o: Row, now = Date.now()) =>
  !!o.scheduled_at && time(o.scheduled_at) > now + SCHEDULED_BOOKING_LEAD_MS;

/**
 * Patch for the requested rider's accept. The delivery mode comes from the
 * stored `offered_mode` — never inferred from `offered_driver_id`, which the
 * FK nulls when the driver row is deleted. Null = the request is inconsistent
 * (own request whose driver is gone, or no mode): the caller answers 409.
 */
export function acceptPatch(o: Row, riderId: string, nowIso: string, opts: { scheduled: boolean }) {
  const mode = o.offered_mode as OfferMode | null;
  if (mode !== "own" && mode !== "blink") return null;
  if (mode === "own" && !o.offered_driver_id) return null;
  return {
    rider_id: riderId,
    rider_assigned_at: nowIso,
    ...(opts.scheduled ? {} : { status: "heading_to_store" as const }),
    ...(o.type === "merchant"
      ? { delivery_mode: mode, store_driver_id: mode === "own" ? (o.offered_driver_id as string) : null }
      : {}),
    ...CLEAR_OFFER,
  };
}

/** Patch for an open-pool claim: always a Blink delivery; stale request columns go. */
export function poolClaimPatch(o: Row, riderId: string, nowIso: string, opts: { scheduled: boolean }) {
  return {
    rider_id: riderId,
    rider_assigned_at: nowIso,
    ...(opts.scheduled ? {} : { status: "heading_to_store" as const }),
    ...(o.type === "merchant" ? { delivery_mode: "blink" as const, store_driver_id: null } : {}),
    ...CLEAR_OFFER,
  };
}

/**
 * Undo a claim (acceptPatch / poolClaimPatch) whose trip insert failed: the
 * order is unassigned again exactly as it was read — delivery mode, store
 * driver and request included — so a store's request is still the requested
 * rider's to accept, and the merchant keeps seeing declined / expired.
 */
export function claimRollback(o: Row) {
  return {
    rider_id: null,
    rider_assigned_at: null,
    status: "searching" as const,
    ...(o.type === "merchant"
      ? { delivery_mode: o.delivery_mode ?? null, store_driver_id: o.store_driver_id ?? null }
      : {}),
    offered_rider_id: o.offered_rider_id ?? null,
    offered_driver_id: o.offered_driver_id ?? null,
    offered_mode: o.offered_mode ?? null,
    offered_at: o.offered_at ?? null,
    offer_declined_at: o.offer_declined_at ?? null,
  };
}

/**
 * Whether a rider can be sent a store request right now. The same rule as
 * GET /riders/jobs/offer, which only serves riders who are online (a missing
 * rider_profiles row counts as offline) and not on a job. A rider already
 * answering another store's request counts as busy.
 */
export function riderAvailability(input: {
  isAvailable: boolean | null | undefined;
  busy: boolean;
  requestedElsewhere: boolean;
}): "available" | "busy" | "offline" {
  if (input.isAvailable !== true) return "offline";
  if (input.busy || input.requestedElsewhere) return "busy";
  return "available";
}

/**
 * Riders held by open requests (`rows`: orders carrying a request), split
 * into `orderId`'s own target and riders another order's request still holds.
 * Only the latter count against a new request (riderAvailability's
 * requestedElsewhere): asking the same rider again on the same order is fine.
 */
export function heldRequestTargets(rows: Row[], orderId: string | undefined, now = Date.now()) {
  const here = new Set<string>();
  const elsewhere = new Set<string>();
  for (const o of rows) {
    if (!isHeld(o, now)) continue;
    (o.id === orderId ? here : elsewhere).add(o.offered_rider_id as string);
  }
  return { here, elsewhere };
}
