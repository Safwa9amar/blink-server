/**
 * Who hears about a new pool job by push (pure — `offer-push.ts` does the I/O).
 * Mirrors the rider-side filters of `GET /riders/jobs/offer`.
 */
import { riderCanTake } from "./courier";
import { haversineKm } from "./courier-pricing";
import { riderCanTakeRide } from "./ride";

type Row = Record<string, any>;
type Point = { lat: number | null; lng: number | null };

/** Nearest riders pushed per job: enough to fill it, not a city-wide blast. */
export const OFFER_PUSH_MAX_RIDERS = 20;

export interface OfferPushRider extends Point {
  id: string;
  vehicleType: string | null;
}

/** Riders within `radiusKm` of the nearest pickup, nearest first, at most `limit`. */
export function ridersNear(
  pickups: Point[],
  riders: OfferPushRider[],
  radiusKm: number,
  limit: number
): OfferPushRider[] {
  const points = pickups.filter((p): p is { lat: number; lng: number } => p.lat != null && p.lng != null);
  if (!points.length) return [];
  return riders
    .flatMap((r) => {
      if (r.lat == null || r.lng == null) return [];
      const at = { lat: r.lat, lng: r.lng };
      const km = Math.min(...points.map((p) => haversineKm(p, at)));
      return km <= radiusKm ? [{ r, km }] : [];
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, limit)
    .map(({ r }) => r);
}

/**
 * Of riders already near the job (nearest first), the ones who can take it:
 * not busy, not declined (or just released it), not its customer, the right
 * vehicle (and gender, for a ride reserved for a woman). Capped at
 * {@link OFFER_PUSH_MAX_RIDERS}.
 */
export function pickOfferRecipients(input: {
  /** The job's orders: one, or every member of a checkout. */
  members: Row[];
  near: OfferPushRider[];
  skip: Set<string>;
  busy: Set<string>;
  genders?: Map<string, string | null>;
}): string[] {
  const { members, near, skip, busy, genders } = input;
  if (!members.length) return [];
  const customers = new Set(members.map((m) => m.customer_id));
  const single = members.length === 1 ? members[0] : null;

  return near
    .filter((r) => {
      if (customers.has(r.id) || skip.has(r.id) || busy.has(r.id)) return false;
      // A motorcycle courier request never goes to a bicycle.
      if (single?.type === "courier" && !riderCanTake(single.vehicle_type, r.vehicleType)) return false;
      // A ride needs a motorcycle (and a woman, when the customer asked for one).
      if (
        single?.type === "ride" &&
        !riderCanTakeRide(single, { vehicleType: r.vehicleType, gender: genders?.get(r.id) ?? null })
      ) {
        return false;
      }
      return true;
    })
    .slice(0, OFFER_PUSH_MAX_RIDERS)
    .map((r) => r.id);
}
