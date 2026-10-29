// Shared by POST /courier/quote and POST /courier/requests: coupon pricing on
// a courier fare, and the free riders around a pickup. Rides (routes/ride)
// reuse both: a ride fare is priced like a courier fare.
import { env } from "../../config/env";
import { priceCoupon } from "../../lib/coupons";
import { riderCanTake } from "../../lib/courier";
import { haversineKm, type CourierVehicle, type LatLng } from "../../lib/courier-pricing";
import { getVehicleClasses } from "../../lib/pricing";
import { OFFER_RADIUS_KM } from "../../lib/dispatch";
import { nearbyRidersMap, type MapCandidate } from "../../lib/nearby-riders-map";
import { supabaseAdmin } from "../../lib/supabase";
import { riderEligibility } from "../merchant/orders-shared";

/**
 * A customer coupon applied to a courier fare. A parcel has no subtotal, so
 * the fare stands in for it (min order, percent); free delivery = the fare.
 */
export async function priceCourierCoupon(userId: string, code: string, fare: number) {
  const priced = await priceCoupon(userId, code, fare, 0);
  if (!priced.ok) return priced;
  const cap = priced.coupon.max_discount != null ? Number(priced.coupon.max_discount) : Infinity;
  const raw = priced.coupon.discount_type === "free_delivery" ? Math.min(fare, cap) : priced.discount;
  return { ok: true as const, coupon: priced.coupon, discount: Math.round(Math.min(raw, fare) * 100) / 100 };
}

/**
 * Idle riders (online, not on a job, not answering a store's request) within
 * the offer radius of `point`, with their vehicle, straight-line km and last
 * position (server-side only: the map gets nearbyRidersMap's blurred markers).
 * Shared with rides.
 */
export async function freeRidersNear(point: LatLng): Promise<MapCandidate[]> {
  const { data: profiles } = await supabaseAdmin
    .from("rider_profiles")
    .select("user_id, latitude, longitude, vehicle_type, vehicle_class, location_updated_at")
    .eq("is_available", true)
    .eq("verification_status", "approved")
    .not("latitude", "is", null)
    .not("longitude", "is", null);
  const near = (profiles ?? [])
    .map((p) => {
      const at = { lat: p.latitude as number, lng: p.longitude as number };
      return {
        id: p.user_id as string,
        vehicle: (p.vehicle_type as string | null) ?? null,
        vehicleClass: (p.vehicle_class as string | null) ?? null,
        km: haversineKm(point, at),
        ...at,
        updatedAt: (p.location_updated_at as string | null) ?? null,
      };
    })
    .filter((p) => p.km <= OFFER_RADIUS_KM);
  // Idle only, by the store-assign rule (riderAvailability): not on a job
  // (IN_DELIVERY) and not answering a store's request — those are taken.
  const eligibility = await riderEligibility(near.map((p) => p.id));
  return near.filter((p) => eligibility.get(p.id)?.availability === "available");
}

/** How many riders can take it, and how far the nearest one is (null: none). */
export const riderCount = (able: { km: number }[]) => ({
  count: able.length,
  nearestKm: able.length ? Math.min(...able.map((p) => p.km)) : null,
});

/**
 * What a quote's map shows (nearby_riders_map): up to 12 of `able` — the same
 * riders the nearby_riders counts are taken from — with a position updated in
 * the last 10 minutes, nearest first, blurred and under an opaque token
 * (src/lib/nearby-riders-map.ts). Same radius as the counts.
 */
export const ridersMap = (able: readonly MapCandidate[]) =>
  nearbyRidersMap(able, { now: Date.now(), secret: env.RIDER_MAP_SALT, radiusKm: OFFER_RADIUS_KM });

/**
 * Free riders within the offer radius of `point`: counted per vehicle class
 * (riderCanTake with the rider's class), and all of them on the map (every
 * free rider can take some class's job).
 */
export async function nearbyCourierRiders(point: LatLng) {
  const [free, classes] = await Promise.all([freeRidersNear(point), getVehicleClasses()]);
  return {
    count: (vehicle: CourierVehicle) =>
      riderCount(free.filter((p) => riderCanTake(vehicle, { vehicleType: p.vehicle, vehicleClass: p.vehicleClass }, classes))),
    map: ridersMap(free),
  };
}
