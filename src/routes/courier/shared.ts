// Shared by POST /courier/quote and POST /courier/requests: coupon pricing on
// a courier fare, and the free riders around a pickup.
import { priceCoupon } from "../../lib/coupons";
import { riderCanTake } from "../../lib/courier";
import { haversineKm, type CourierVehicle, type LatLng } from "../../lib/courier-pricing";
import { IN_DELIVERY, OFFER_RADIUS_KM } from "../../lib/dispatch";
import { supabaseAdmin } from "../../lib/supabase";

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

/** Free riders (online, not on a delivery) within the offer radius of `point`, per vehicle. */
export async function nearbyCourierRiders(point: LatLng) {
  const { data: profiles } = await supabaseAdmin
    .from("rider_profiles")
    .select("user_id, latitude, longitude, vehicle_type")
    .eq("is_available", true)
    .not("latitude", "is", null)
    .not("longitude", "is", null);
  const near = (profiles ?? [])
    .map((p) => ({
      id: p.user_id as string,
      vehicle: (p.vehicle_type as string | null) ?? null,
      km: haversineKm(point, { lat: p.latitude as number, lng: p.longitude as number }),
    }))
    .filter((p) => p.km <= OFFER_RADIUS_KM);
  const { data: busy } = near.length
    ? await supabaseAdmin
        .from("orders")
        .select("rider_id")
        .in("rider_id", near.map((p) => p.id))
        .in("status", IN_DELIVERY)
    : { data: [] as { rider_id: string }[] };
  const busyIds = new Set((busy ?? []).map((o) => o.rider_id as string));
  const free = near.filter((p) => !busyIds.has(p.id));

  return (vehicle: CourierVehicle) => {
    const able = free.filter((p) => riderCanTake(vehicle, p.vehicle));
    return {
      count: able.length,
      nearestKm: able.length ? Math.min(...able.map((p) => p.km)) : null,
    };
  };
}
