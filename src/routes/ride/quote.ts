import { quoteRide, ridePickupEtaMinutes } from "../../lib/ride-pricing";
import { rideFareConfig } from "../../lib/pricing/fare-config";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { rideQuoteSchema, RideQuoteResponse } from "../../validators/ride";
import { nearbyRideRiders, priceRideCoupon } from "./shared";

const app = router();

// ─── POST /ride/quote — the fare for every ride product ──────────────
// What the confirm screen shows. POST /ride/requests prices the same trip
// again, so the fare shown is the fare charged.
const route = createRoute({
  method: "post",
  path: "/quote",
  operationId: "quoteRide",
  tags: ["ride"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(rideQuoteSchema), required: true } },
  responses: {
    200: json(RideQuoteResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { pickup, destination, coupon_code, female_rider_only } = c.req.valid("json");

  const cfg = await rideFareConfig(pickup, destination);
  // One option per enabled ride class that has a price here (the live app only knows `motorcycle` until staff enable more).
  const quote = quoteRide(pickup, destination, cfg.rates, cfg.multiplier, {
    formula: cfg.formula,
    surcharge: cfg.surcharge,
    enabled: cfg.enabled,
    classes: cfg.legs,
  });
  const riders = await nearbyRideRiders(pickup, female_rider_only, quote.options.map((o) => o.vehicle_type));

  let couponReason: string | null = null;
  let couponValid = false;
  const options = await Promise.all(
    quote.options.map(async (o) => {
      let discount = 0;
      if (coupon_code) {
        const priced = await priceRideCoupon(user.id, coupon_code, o.fare);
        if (priced.ok) {
          discount = priced.discount;
          couponValid = true;
        } else {
          couponReason ??= priced.reason;
        }
      }
      const near = riders.count(o.vehicle_type);
      // A female-rider-only ride needs a female rider around ("subject to availability").
      const noFemaleRider = female_rider_only && near.count === 0;
      return {
        vehicle_type: o.vehicle_type,
        vehicle_name: o.vehicle_name,
        base_vehicle: o.base_vehicle,
        fare: o.fare,
        discount,
        total: Math.max(0, o.fare - discount),
        duration_minutes: o.duration_minutes,
        available: o.available && !noFemaleRider,
        unavailable_reason: o.unavailable_reason ?? (noFemaleRider ? ("no_female_rider" as const) : null),
        pickup_eta_minutes: ridePickupEtaMinutes(o.vehicle_type, near.nearestKm, cfg.formula, o.base_vehicle),
        nearby_riders: near.count,
      };
    })
  );

  return c.json(
    {
      distance_km: quote.distance_km,
      options,
      nearby_riders_map: riders.map,
      ...(coupon_code
        ? { coupon: { code: coupon_code, valid: couponValid, reason: couponValid ? null : couponReason } }
        : {}),
    },
    200
  );
});

export default app;
