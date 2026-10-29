import { randomUUID } from "node:crypto";
import {
  buildCourierDetails,
  COURIER_STORE_NAME,
  courierItems,
  scheduleError,
} from "../../lib/courier";
import { courierFare, routeKm, type CourierVehicle } from "../../lib/courier-pricing";
import { courierFareConfig, placeColumns } from "../../lib/pricing/fare-config";
import { claimCoupon, linkCoupon, releaseCoupon } from "../../lib/coupons";
import { withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { CourierRequestResponse, createCourierRequestSchema } from "../../validators/courier";
import { pushNewOffer } from "../../lib/offer-push";
import { priceCourierCoupon } from "./shared";

const app = router();

// ─── POST /courier/requests — request one courier per route ──────────
// Every route becomes a `courier` order in `searching` (one rider each),
// priced here — never by the client. The orders share courier_group_id
// (GET /orders?courier_group_id=…). Riders see them through /riders/jobs.
const route = createRoute({
  method: "post",
  path: "/requests",
  operationId: "createCourierRequest",
  tags: ["courier"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(createCourierRequestSchema), required: true } },
  responses: {
    201: json(CourierRequestResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
    409: json(ErrorSchema, "The coupon was just used by another request"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const vehicle = body.vehicle_type as CourierVehicle;

  const scheduleProblem = scheduleError(body.scheduled_at);
  if (scheduleProblem) return c.json({ error: scheduleProblem }, 400);

  // Rates + multiplier come from the pricing config for each route's pickup wilaya.
  const priced = await Promise.all(
    body.routes.map(async (r) => {
      const cfg = await courierFareConfig(r.pickup, r.drop_offs[r.drop_offs.length - 1]);
      const km = routeKm(r.pickup, r.drop_offs, cfg.formula);
      const chosen = cfg.legs.find((l) => l.cls.code === vehicle);
      return {
        route: r,
        km,
        cfg,
        chosen,
        maxKm: chosen?.leg.max_km ?? 0,
        fare: chosen
          ? courierFare(vehicle, km, r.drop_offs.length, cfg.rates, cfg.multiplier, {
              formula: cfg.formula,
              surcharge: cfg.surcharge,
              classes: cfg.legs,
            })
          : 0,
        applied: cfg.appliedFor(vehicle),
      };
    })
  );
  const outside = priced.findIndex((p) => !p.cfg.enabled);
  if (outside !== -1) {
    return c.json(
      { error: `Courier ${outside + 1}'s pickup is outside our service area`, code: "out_of_service_area" },
      400
    );
  }
  // Any enabled courier class priced on every route; the quote lists them.
  const unpriced = priced.findIndex((p) => !p.chosen);
  if (unpriced !== -1) return c.json({ error: `vehicle_type "${vehicle}" isn't an available courier option` }, 400);
  const tooLong = priced.findIndex((p) => p.km > p.maxKm);
  if (tooLong !== -1) {
    return c.json(
      {
        error: `Route too long: courier ${tooLong + 1} is ${priced[tooLong].km} km, a ${vehicle} takes up to ${priced[tooLong].maxKm} km`,
      },
      400
    );
  }

  // The coupon is used once: on the first route.
  let discount = 0;
  let couponId: string | null = null;
  if (body.coupon_code) {
    const coupon = await priceCourierCoupon(user.id, body.coupon_code, priced[0].fare);
    if (!coupon.ok) return c.json({ error: `Coupon not applicable: ${coupon.reason}` }, 400);
    discount = coupon.discount;
    couponId = coupon.coupon.id;
  }

  // Claimed first, only if still unused (see POST /ride/requests).
  if (couponId && !(await claimCoupon(couponId))) {
    return c.json({ error: "This coupon was just used — remove it and try again" }, 409);
  }

  const groupId = randomUUID();
  const rows = priced.map((p, i) => {
    const courier = buildCourierDetails(p.route, body.paid_by, p.km);
    const last = courier.drop_offs[courier.drop_offs.length - 1];
    const off = i === 0 ? discount : 0;
    return {
      customer_id: user.id,
      store_name: COURIER_STORE_NAME,
      type: "courier" as const,
      status: "searching" as const,
      items: courierItems(courier),
      subtotal: 0,
      delivery_fee: p.fare,
      service_fee: 0,
      discount: off,
      total: Math.max(0, p.fare - off),
      coupon_id: i === 0 ? couponId : null,
      pickup_address: courier.pickup.address,
      destination_address: last.address,
      pickup_lat: courier.pickup.lat,
      pickup_lng: courier.pickup.lng,
      destination_lat: last.lat,
      destination_lng: last.lng,
      vehicle_type: vehicle,
      scheduled_at: body.scheduled_at ?? null,
      courier,
      courier_group_id: groupId,
      pricing_applied: p.applied,
      ...placeColumns(p.cfg.place),
    };
  });

  // One INSERT: every route is created, or none is.
  const { data, error } = await supabaseAdmin.from("orders").insert(rows).select();
  if (error || !data?.length) {
    if (couponId) await releaseCoupon(couponId, null);
    return c.json({ error: error?.message ?? "Couldn't create the request" }, 400);
  }
  if (couponId) await linkCoupon(couponId, (data.find((o) => o.coupon_id === couponId) ?? data[0]).id);

  // Riders with the app in the background (the open app hears the socket).
  for (const o of data) void pushNewOffer(o.id);

  // INSERT … RETURNING keeps the routes' order.
  return c.json({ orders: data.map((o) => withoutOffer(o)) }, 201);
});

export default app;
