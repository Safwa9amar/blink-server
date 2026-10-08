import { createNotification } from "../../lib/notifications";
import { CLEAR_OFFER, isHeld, isLiveOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, IdParam, json, router } from "../../openapi";
import { assignRiderSchema, EnrichedMerchantOrderResponse } from "../../validators/merchant";
import { enrichOrders, nearestAvailableRider, riderEligibility } from "./orders-shared";
import { orderRef, ownedStore } from "./shared";

const app = router();

// ─── Merchant: get a rider for an accepted / prepared order ──────────
// A rider with the Blink app is never assigned from here: the store sends a
// REQUEST and nothing moves until that rider accepts it (POST
// /riders/jobs/{id}/accept), so the customer, merchant and rider apps move on
// together. Until then the order stays `searching` with no rider_id
// (customer: "searching for a rider"; merchant: "waiting for <rider>", then
// offer_status declined | expired). Rules: src/lib/rider-offer.ts.
// own:   one of the store's drivers.
//        - external driver (no app account): assigned at once, heading to the
//          store; the merchant then marks picked up / delivered (PATCH
//          /merchant/orders/{id}).
//        - app driver: a request (offered_mode own).
// blink: a request to a Blink rider (rider_id, or omit to auto-match the
//        nearest one who can take it).
// DELETE /merchant/orders/{id}/offer withdraws a request. Never for
// multi-store checkout orders (400): one Blink rider collects the whole
// checkout through the rider offer.
const route = createRoute({
  method: "post",
  path: "/orders/{id}/assign",
  operationId: "assignOrderRider",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam, body: { ...json(assignRiderSchema), required: true } },
  responses: {
    200: json(EnrichedMerchantOrderResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(ErrorSchema, "The order changed meanwhile, or this rider is already asked"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select(
      "id, store_id, store_name, status, merchant_status, rider_id, customer_id, checkout_id, offered_rider_id, offered_mode, offered_at, offer_declined_at"
    )
    .eq("id", id)
    .maybeSingle();
  const store = order?.store_id ? await ownedStore(user.id, order.store_id) : null;
  if (!order || !store) return c.json({ error: "Order not found" }, 404);
  if (order.checkout_id) {
    return c.json({ error: "Multi-store orders are assigned to one Blink rider automatically" }, 400);
  }
  if (!["accepted", "ready"].includes(order.merchant_status ?? "")) {
    return c.json({ error: "Accept the order before assigning a rider" }, 400);
  }
  if (!["processing", "searching"].includes(order.status) || order.rider_id) {
    return c.json({ error: "Order already has a rider" }, 400);
  }

  // Server clock only: offered_at drives the answer countdown on both apps.
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // Compare-and-swap on what was read: an accept, another request or a status
  // change in between makes the write miss (409).
  const write = (patch: Record<string, unknown>) => {
    let q = supabaseAdmin
      .from("orders")
      .update(patch)
      .eq("id", id)
      .is("rider_id", null)
      .eq("status", order.status)
      .in("merchant_status", ["accepted", "ready"]);
    q = order.offered_rider_id ? q.eq("offered_rider_id", order.offered_rider_id) : q.is("offered_rider_id", null);
    q = order.offered_at ? q.eq("offered_at", order.offered_at) : q.is("offered_at", null);
    return q.select().maybeSingle();
  };
  const changed = () => c.json({ error: "Order changed, refresh and try again" }, 409);

  let target: string;
  let driverId: string | null = null;

  if (body.mode === "own") {
    const { data: driver } = await supabaseAdmin
      .from("store_drivers")
      .select("*")
      .eq("id", body.rider_id!)
      .eq("store_id", store.id)
      .eq("status", "active")
      .maybeSingle();
    if (!driver) return c.json({ error: "Driver not found" }, 404);

    if (!driver.rider_user_id) {
      // No app to answer a request: the merchant drives this delivery, so it
      // starts now. heading_to_store, not pickup — pickup means a rider
      // reported arriving at the store.
      const { data: row, error } = await write({
        delivery_mode: "own",
        store_driver_id: driver.id,
        rider_id: null,
        status: "heading_to_store",
        rider_assigned_at: nowIso,
        ...CLEAR_OFFER,
      });
      if (error) return c.json({ error: error.message }, 400);
      if (!row) return changed();
      const [assigned] = await enrichOrders([row]);
      return c.json({ order: assigned }, 200);
    }
    target = driver.rider_user_id;
    driverId = driver.id;
  } else {
    let riderId = body.rider_id;
    if (!riderId) {
      // Auto-match: nearest rider a request can reach (same rule as GET …/riders).
      riderId = (await nearestAvailableRider(store, { orderId: id }))?.id;
      if (!riderId) return c.json({ error: "No Blink rider available right now" }, 400);
    }
    target = riderId;
  }

  const { data: rider } = await supabaseAdmin
    .from("users")
    .select("id")
    .eq("id", target)
    .eq("role", "rider")
    .maybeSingle();
  if (!rider) return c.json({ error: "Rider not found" }, 404);

  const mode = body.mode;
  const askedAlready = order.offered_rider_id === target;
  if (askedAlready && isLiveOffer(order, now) && order.offered_mode === mode) {
    return c.json({ error: "Already waiting for this rider to answer" }, 409);
  }
  // Current apps answer a request by its deadline, but older ones send no
  // request identity: a tap on the sheet they were shown would answer a
  // re-sent one on other terms (own driver ↔ Blink rider: trip and
  // commission). While they can still accept (TTL + grace), the store
  // withdraws the request first.
  if (askedAlready && isHeld(order, now) && order.offered_mode !== mode) {
    return c.json({ error: "Withdraw your request to this rider before asking in another mode" }, 409);
  }
  const unavailable = (availability: "busy" | "offline") =>
    c.json(
      { error: availability === "offline" ? "This rider is offline in the Blink app" : "This rider is busy right now" },
      400
    );
  // A rider who declined this order earlier may still be asked again explicitly.
  const availability = (await riderEligibility([target], { orderId: id, now })).get(target)?.availability;
  if (availability === "offline" || availability === "busy") return unavailable(availability);

  // The request only: rider_id, rider_assigned_at, delivery_mode and
  // store_driver_id are set by the rider's accept.
  const { data: row, error } = await write({
    offered_rider_id: target,
    offered_driver_id: mode === "own" ? driverId : null,
    offered_mode: mode,
    offered_at: nowIso,
    offer_declined_at: null,
    ...(order.status === "processing" ? { status: "searching" } : {}),
  });
  if (error) return c.json({ error: error.message }, 400);
  if (!row) return changed();

  // The check above and this write aren't atomic. A rider who went offline or
  // took a job in between released their requests before this one existed, so
  // it would hold the order unseen for TTL + grace. Check again now that it's
  // written, and end it the way releaseRiderRequests would (declined).
  const after = (await riderEligibility([target], { orderId: id, now })).get(target)?.availability;
  if (after === "offline" || after === "busy") {
    const { data: ended } = await supabaseAdmin
      .from("orders")
      .update({ offer_declined_at: new Date().toISOString() })
      .eq("id", id)
      .eq("offered_rider_id", target)
      .eq("offered_at", nowIso)
      .is("rider_id", null)
      .eq("status", "searching")
      .is("offer_declined_at", null)
      .select("id")
      .maybeSingle();
    // No row: the request was answered or replaced meanwhile.
    return ended ? unavailable(after) : changed();
  }

  const ref = orderRef(id);
  const storeName = order.store_name;
  await createNotification({
    userId: target,
    type: "order",
    title: "Delivery request",
    description: `${storeName} asks you to deliver order ${ref}. Open Blink to accept.`,
    contentFr: {
      title: "Demande de livraison",
      description: `${storeName} vous demande de livrer la commande ${ref}. Ouvrez Blink pour accepter.`,
    },
    contentAr: { title: "طلب توصيل", description: `${storeName} يطلب منك توصيل الطلب ${ref}. افتح Blink للقبول.` },
    href: "/(rider)",
  }).catch(() => null);

  const [requested] = await enrichOrders([row]);
  return c.json({ order: requested }, 200);
});

export default app;
