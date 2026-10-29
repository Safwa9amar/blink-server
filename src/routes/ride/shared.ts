// Shared by POST /ride/quote and POST /ride/requests: coupon pricing on a ride
// fare, and the free riders around a pickup who can take the ride.
import { type LatLng } from "../../lib/courier-pricing";
import { getVehicleClasses } from "../../lib/pricing";
import { riderCanTakeRide } from "../../lib/ride";
import { supabaseAdmin } from "../../lib/supabase";
import { freeRidersNear, priceCourierCoupon, riderCount, ridersMap } from "../courier/shared";

/**
 * A customer coupon applied to a ride fare: priced like a courier fare (no
 * subtotal — the fare stands in for it; free delivery = the fare).
 */
export const priceRideCoupon = priceCourierCoupon;

/**
 * Free riders within the offer radius of `pickup` who can take a ride of each
 * offered class: a motorcycle (or, for an exclusive class like Comfort, a rider
 * of that class), and women only when `femaleRiderOnly`
 * (src/lib/ride.ts riderCanTakeRide). `count(code)` is per class; the map shows
 * the riders able to take at least one of `codes`, so it only shows who could
 * take something offered.
 */
export async function nearbyRideRiders(pickup: LatLng, femaleRiderOnly: boolean, codes: string[] = ["motorcycle"]) {
  const [free, classes] = await Promise.all([freeRidersNear(pickup), getVehicleClasses()]);
  const motos = free.filter((p) => p.vehicle === "motorcycle");
  // Gender is only read when it matters.
  const { data: users } =
    femaleRiderOnly && motos.length
      ? await supabaseAdmin.from("users").select("id, gender").in("id", motos.map((p) => p.id))
      : { data: [] as { id: string; gender: string | null }[] };
  const genderOf = new Map((users ?? []).map((u) => [u.id as string, (u.gender as string | null) ?? null]));
  const ableFor = (code: string) => {
    const ride = { type: "ride", vehicle_type: code, ride: { female_rider_only: femaleRiderOnly } };
    return motos.filter((p) =>
      riderCanTakeRide(ride, { vehicleType: p.vehicle, vehicleClass: p.vehicleClass, gender: genderOf.get(p.id) ?? null }, classes)
    );
  };
  const perClass = new Map(codes.map((code) => [code, ableFor(code)]));
  const union = motos.filter((p) => [...perClass.values()].some((able) => able.includes(p)));
  return {
    count: (code: string) => riderCount(perClass.get(code) ?? ableFor(code)),
    map: ridersMap(union),
  };
}
