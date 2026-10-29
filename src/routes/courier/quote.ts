import { COURIER_VEHICLES, pickupEtaMinutes, quoteRoute } from "../../lib/courier-pricing";
import { courierFareConfig } from "../../lib/pricing/fare-config";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { courierQuoteSchema, CourierQuoteResponse } from "../../validators/courier";
import { nearbyCourierRiders, priceCourierCoupon } from "./shared";

const app = router();

// ─── POST /courier/quote — prices for every vehicle ──────────────────
// What the vehicle sheet shows. POST /courier/requests prices the same route
// again, so the fare shown is the fare charged.
const route = createRoute({
  method: "post",
  path: "/quote",
  operationId: "quoteCourier",
  tags: ["courier"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(courierQuoteSchema), required: true } },
  responses: {
    200: json(CourierQuoteResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { routes, coupon_code } = c.req.valid("json");

  // Priced at each route's pickup place; the surcharge at its last drop-off's.
  const cfgs = await Promise.all(routes.map((r) => courierFareConfig(r.pickup, r.drop_offs[r.drop_offs.length - 1])));
  const quotes = routes.map((r, i) =>
    quoteRoute(r.pickup, r.drop_offs, cfgs[i].rates, cfgs[i].multiplier, {
      formula: cfgs[i].formula,
      surcharge: cfgs[i].surcharge,
      enabled: cfgs[i].enabled,
    })
  );
  const nearby = await nearbyCourierRiders(routes[0].pickup);

  let couponReason: string | null = null;
  let couponValid = false;
  const options = await Promise.all(
    COURIER_VEHICLES.map(async (vehicle) => {
      const per = quotes.map((q) => q.options.find((o) => o.vehicle_type === vehicle)!);
      const fare = per.reduce((n, o) => n + o.fare, 0);
      // A coupon is used once: on the first route's fare.
      let discount = 0;
      if (coupon_code) {
        const priced = await priceCourierCoupon(user.id, coupon_code, per[0].fare);
        if (priced.ok) {
          discount = priced.discount;
          couponValid = true;
        } else {
          couponReason ??= priced.reason;
        }
      }
      const riders = nearby.count(vehicle);
      return {
        vehicle_type: vehicle,
        fare,
        discount,
        total: Math.max(0, fare - discount),
        duration_minutes: Math.max(...per.map((o) => o.duration_minutes)),
        available: per.every((o) => o.available),
        // Outside the service area wins over "too far": it can't be fixed by shortening the route.
        unavailable_reason:
          per.find((o) => o.unavailable_reason === "out_of_service_area")?.unavailable_reason ??
          per.find((o) => o.unavailable_reason)?.unavailable_reason ??
          null,
        pickup_eta_minutes: pickupEtaMinutes(vehicle, riders.nearestKm, cfgs[0].formula),
        nearby_riders: riders.count,
      };
    })
  );

  return c.json(
    {
      routes: quotes.map((q) => ({ distance_km: q.distance_km })),
      options,
      nearby_riders_map: nearby.map,
      ...(coupon_code
        ? { coupon: { code: coupon_code, valid: couponValid, reason: couponValid ? null : couponReason } }
        : {}),
    },
    200
  );
});

export default app;
