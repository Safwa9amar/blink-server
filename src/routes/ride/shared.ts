// Shared by POST /ride/quote and POST /ride/requests: coupon pricing on a ride
// fare, and the free riders around a pickup who can take the ride.
import { type LatLng } from "../../lib/courier-pricing";
import { riderCanTakeRide } from "../../lib/ride";
import { supabaseAdmin } from "../../lib/supabase";
import { freeRidersNear, priceCourierCoupon, riderCount, ridersMap } from "../courier/shared";

/**
 * A customer coupon applied to a ride fare: priced like a courier fare (no
 * subtotal — the fare stands in for it; free delivery = the fare).
 */
export const priceRideCoupon = priceCourierCoupon;

/**
 * Free riders within the offer radius of `pickup` who can take a ride:
 * motorcycle only, and women only when `femaleRiderOnly`
 * (src/lib/ride.ts riderCanTakeRide) — counted, and the same riders on the
 * map (nearby_riders_map), so the map only shows who could take it.
 */
export async function nearbyRideRiders(pickup: LatLng, femaleRiderOnly: boolean) {
  const free = await freeRidersNear(pickup);
  const motos = free.filter((p) => p.vehicle === "motorcycle");
  // Gender is only read when it matters.
  const { data: users } =
    femaleRiderOnly && motos.length
      ? await supabaseAdmin.from("users").select("id, gender").in("id", motos.map((p) => p.id))
      : { data: [] as { id: string; gender: string | null }[] };
  const genderOf = new Map((users ?? []).map((u) => [u.id as string, (u.gender as string | null) ?? null]));
  const ride = { type: "ride", ride: { female_rider_only: femaleRiderOnly } };
  const able = motos.filter((p) =>
    riderCanTakeRide(ride, { vehicleType: p.vehicle, gender: genderOf.get(p.id) ?? null })
  );
  return { ...riderCount(able), map: ridersMap(able) };
}
