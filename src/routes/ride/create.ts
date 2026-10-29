import { claimCoupon, linkCoupon, releaseCoupon } from "../../lib/coupons";
import { scheduleError } from "../../lib/courier";
import { buildRideDetails, RIDE_STORE_NAME, rideItems } from "../../lib/ride";
import { rideDuration, rideFare, rideKm, rideMaxKm, rideRouteError, type RideVehicle } from "../../lib/ride-pricing";
import { placeColumns, rideFareConfig } from "../../lib/pricing/fare-config";
import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { createRideRequestSchema, RideRequestResponse } from "../../validators/ride";
import { pushNewOffer } from "../../lib/offer-push";
import { priceRideCoupon } from "./shared";

const app = router();

// ─── POST /ride/requests — request a ride ────────────────────────────
// One `ride` order in `searching`, priced here — never by the client. Riders
// with a motorcycle (a woman's, when female_rider_only) see it through
// /riders/jobs; unclaimed, it is canceled (no_rider) 10 minutes after going
// live. The passenger pays the rider in cash at the end.
const route = createRoute({
  method: "post",
  path: "/requests",
  operationId: "createRideRequest",
  tags: ["ride"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(createRideRequestSchema), required: true } },
  responses: {
    201: json(RideRequestResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
    409: json(ErrorSchema, "The coupon was just used by another request"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const vehicle = body.vehicle_type as RideVehicle;

  const scheduleProblem = scheduleError(body.scheduled_at);
  if (scheduleProblem) return c.json({ error: scheduleProblem }, 400);

  const cfg = await rideFareConfig(body.pickup, body.destination);
  if (!cfg.enabled) return c.json({ error: "Rides aren't available at this pickup yet", code: "out_of_service_area" }, 400);
  const routeProblem = rideRouteError(body.pickup, body.destination, cfg.rates, vehicle, cfg.formula);
  if (routeProblem === "too_close") {
    return c.json({ error: "Pickup and destination are too close for a ride" }, 400);
  }
  const km = rideKm(body.pickup, body.destination, cfg.formula);
  if (routeProblem === "too_far") {
    return c.json({ error: `Ride too long: ${km} km, a ride goes up to ${rideMaxKm(vehicle, cfg.rates)} km` }, 400);
  }
  const fare = rideFare(vehicle, km, cfg.rates, cfg.multiplier, { formula: cfg.formula, surcharge: cfg.surcharge });

  let discount = 0;
  let couponId: string | null = null;
  if (body.coupon_code) {
    const coupon = await priceRideCoupon(user.id, body.coupon_code, fare);
    if (!coupon.ok) return c.json({ error: `Coupon not applicable: ${coupon.reason}` }, 400);
    discount = coupon.discount;
    couponId = coupon.coupon.id;
  }

  // The coupon is claimed first, only if still unused: two requests racing on
  // one coupon can't both get the discount. Handed back if the ride isn't created.
  if (couponId && !(await claimCoupon(couponId))) {
    return c.json({ error: "This coupon was just used — remove it and try again" }, 409);
  }

  const ride = buildRideDetails(body, { distanceKm: km, durationMinutes: rideDuration(vehicle, km, cfg.formula) });
  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: user.id,
      store_name: RIDE_STORE_NAME,
      type: "ride",
      status: "searching",
      items: rideItems(ride),
      subtotal: 0,
      delivery_fee: fare,
      service_fee: 0,
      discount,
      total: Math.max(0, fare - discount),
      coupon_id: couponId,
      pickup_address: ride.pickup.address,
      destination_address: ride.destination.address,
      pickup_lat: ride.pickup.lat,
      pickup_lng: ride.pickup.lng,
      destination_lat: ride.destination.lat,
      destination_lng: ride.destination.lng,
      vehicle_type: vehicle,
      scheduled_at: body.scheduled_at ?? null,
      ride,
      pricing_applied: cfg.applied,
      ...placeColumns(cfg.place),
    })
    .select()
    .single();
  if (error || !data) {
    if (couponId) await releaseCoupon(couponId, null);
    return c.json({ error: error?.message ?? "Couldn't request the ride" }, 400);
  }
  if (couponId) await linkCoupon(couponId, data.id);
  // Riders with the app in the background (the open app hears the socket).
  void pushNewOffer(data.id);

  return c.json({ order: withoutOffer(data) }, 201);
});

export default app;
