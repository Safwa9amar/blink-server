import { bundleMembers, leadOrder } from "../../lib/bundle";
import { loadBundle } from "../../lib/dispatch";
import { createNotification } from "../../lib/notifications";
import { CLEAR_OFFER, withoutOffer } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, IdParam, json, router } from "../../openapi";
import { OrderResponse, updateOrderStatusSchema } from "../../validators/orders";
import { orderRef } from "../merchant/shared";

const app = router();

// ─── Update order status ─────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/{id}/status",
  operationId: "updateOrderStatus",
  tags: ["orders"],
  security: bearer,
  request: { params: IdParam, body: { ...json(updateOrderStatusSchema), required: true } },
  responses: {
    200: json(OrderResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(ErrorSchema, "The order changed meanwhile (staff)"),
  },
});

// A customer may cancel their own order until it's picked up.
const CUSTOMER_CANCELABLE = new Set(["searching", "processing", "heading_to_store", "preparation"]);

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: orderId } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, rider_id, status, checkout_id, type")
    .eq("id", orderId)
    .maybeSingle();

  if (!order) {
    return c.json({ error: "Order not found" }, 404);
  }

  // ─── Authorization ─────────────────────────────────────────────────
  // Staff: anything. Customer: cancel own order before pickup. Rider: never.
  if (!user.staff_role) {
    if (user.role === "customer") {
      if (order.customer_id !== user.id) {
        return c.json({ error: "Access denied" }, 403);
      }
      if (body.status !== "canceled" || body.rider_id || body.estimated_time) {
        return c.json({ error: "Customers can only cancel an order" }, 403);
      }
      if (!CUSTOMER_CANCELABLE.has(order.status)) {
        return c.json({ error: "Order can no longer be canceled" }, 400);
      }
    } else if (user.role === "rider") {
      // The rider app drives orders only through /riders/jobs (accept →
      // arrived → picked up → delivered). This route let a rider claim an
      // order or jump statuses without accepting a store's request.
      return c.json({ error: "Use the rider jobs flow" }, 403);
    } else {
      return c.json({ error: "Access denied" }, 403);
    }
  }

  // Staff too: a rider is put on an order only by their own accept (POST
  // /riders/jobs/{id}/accept), which also creates the trip and frees the
  // stores waiting on them. Writing rider_id here skipped all of that, and the
  // rider app jumped into a job it never accepted.
  if (body.rider_id) {
    return c.json({ error: "A rider is assigned only by accepting the job in the rider app" }, 400);
  }

  // ─── Multi-store checkout: the customer cancels the whole checkout ──
  // One rider collects every store's order, so they're canceled together, and
  // only while none of them has been picked up.
  if (!user.staff_role && user.role === "customer" && order.checkout_id) {
    const rows = await loadBundle(order.checkout_id);
    const members = bundleMembers(rows);
    if (!members.every((m) => CUSTOMER_CANCELABLE.has(m.status))) {
      return c.json({ error: "Order can no longer be canceled" }, 400);
    }
    const now = new Date().toISOString();
    const { data: canceled, error } = await supabaseAdmin
      .from("orders")
      .update({ status: "canceled", canceled_at: now, canceled_by: "customer", ...cancelDetails(body), ...CLEAR_OFFER })
      .in("id", members.map((m) => m.id))
      .in("status", [...CUSTOMER_CANCELABLE])
      .select();
    const self = (canceled ?? []).find((o) => o.id === orderId);
    // All or nothing: if a stop moved on meanwhile (e.g. the rider reached a
    // store), restore what was canceled and refuse. (Checkout orders never
    // carry a store's rider request, so there is no request to restore.)
    if (error || !self || (canceled ?? []).length !== members.length) {
      for (const row of canceled ?? []) {
        const before = members.find((m) => m.id === row.id);
        if (!before) continue;
        await supabaseAdmin
          .from("orders")
          .update({ status: before.status, canceled_at: null, canceled_by: null })
          .eq("id", row.id)
          .eq("status", "canceled");
      }
      return c.json({ error: error?.message ?? "Order can no longer be canceled" }, 400);
    }

    // Free the rider. Their trip is closed with no penalty, because the rider didn't cancel.
    await supabaseAdmin
      .from("trips")
      .update({ status: "canceled", cancellation_reason: "canceled_by_customer" })
      .in("order_id", rows.map((r) => r.id))
      .eq("status", "upcoming");
    const riderId = members.find((m) => m.rider_id)?.rider_id as string | undefined;
    if (riderId) {
      const ref = orderRef(leadOrder(members).id);
      await createNotification({
        userId: riderId,
        type: "order",
        title: "Order canceled",
        description: `The customer canceled order ${ref}. You're free for a new job.`,
        contentFr: {
          title: "Commande annulée",
          description: `Le client a annulé la commande ${ref}. Vous êtes libre pour une nouvelle course.`,
        },
        contentAr: { title: "تم إلغاء الطلب", description: `ألغى الزبون الطلب ${ref}. أنت متاح لطلب جديد.` },
      }).catch(() => null);
    }
    return c.json({ order: withoutOffer(self) }, 200);
  }

  const updatePayload: Record<string, unknown> = { status: body.status };
  if (body.estimated_time) updatePayload.estimated_time = body.estimated_time;
  // Delivery timeline (merchant order detail).
  const now = new Date().toISOString();
  if (body.status === "on_the_way") updatePayload.picked_up_at = now;
  if (body.status === "delivered") updatePayload.delivered_at = now;
  if (body.status === "canceled") {
    updatePayload.canceled_at = now;
    updatePayload.canceled_by = user.staff_role ? "system" : user.role === "customer" ? "customer" : "system";
    Object.assign(updatePayload, cancelDetails(body));
  }
  // Moving the order on ends a store's pending rider request (the requested
  // rider's sheet closes through realtime).
  if (body.status !== "searching") Object.assign(updatePayload, CLEAR_OFFER);

  // Conditional on what was read. The customer (the only non-staff caller
  // left) cancels from any cancelable status, so a rider accepting meanwhile
  // doesn't block it; a staff write misses if the order moved or got a rider.
  const staff = !!user.staff_role;
  let write = supabaseAdmin.from("orders").update(updatePayload).eq("id", orderId);
  if (staff) {
    write = write.eq("status", order.status);
    write = order.rider_id ? write.eq("rider_id", order.rider_id) : write.is("rider_id", null);
  } else {
    write = write.in("status", [...CUSTOMER_CANCELABLE]);
  }
  const { data, error } = await write.select().maybeSingle();

  if (error) {
    return c.json({ error: "Order not found" }, 404);
  }
  if (!data) {
    return staff
      ? c.json({ error: "Order changed, refresh and try again" }, 409)
      : c.json({ error: "Order can no longer be canceled" }, 400);
  }

  // A canceled order closes the rider's open trip record (dispatch trips).
  // A checkout shares ONE trip across its stores: close it only once no store
  // is left, otherwise the rider still delivers (and is paid for) the rest.
  if (body.status === "canceled") {
    const tripOrderIds = order.checkout_id
      ? await loadBundle(order.checkout_id).then((rows) =>
          bundleMembers(rows).length ? [] : rows.map((r) => r.id as string)
        )
      : [orderId];
    if (tripOrderIds.length) {
      await supabaseAdmin
        .from("trips")
        .update({ status: "canceled", cancellation_reason: `canceled_by_${updatePayload.canceled_by}` })
        .in("order_id", tripOrderIds)
        .eq("status", "upcoming");
    }
    // The rider on it (or who booked it) is free again — say so instead of
    // letting their job vanish with a generic "trip ended".
    if (order.rider_id && !order.checkout_id) {
      const ref = orderRef(orderId);
      const parcel = order.type === "courier";
      await createNotification({
        userId: order.rider_id,
        type: "order",
        title: parcel ? "Delivery canceled" : "Order canceled",
        description: parcel
          ? `The customer canceled parcel delivery ${ref}. You're free for a new job.`
          : `The customer canceled order ${ref}. You're free for a new job.`,
        contentFr: {
          title: parcel ? "Livraison annulée" : "Commande annulée",
          description: parcel
            ? `Le client a annulé la livraison de colis ${ref}. Vous êtes libre pour une nouvelle course.`
            : `Le client a annulé la commande ${ref}. Vous êtes libre pour une nouvelle course.`,
        },
        contentAr: {
          title: parcel ? "تم إلغاء التوصيل" : "تم إلغاء الطلب",
          description: parcel
            ? `ألغى الزبون توصيل الطرد ${ref}. أنت متاح لطلب جديد.`
            : `ألغى الزبون الطلب ${ref}. أنت متاح لطلب جديد.`,
        },
      }).catch(() => null);
    }
  }

  return c.json({ order: withoutOffer(data) }, 200);
});

/** The customer's cancel reason + details, when sent. */
function cancelDetails(body: { cancel_reason?: string; cancel_note?: string }) {
  return {
    ...(body.cancel_reason ? { cancel_reason: body.cancel_reason } : {}),
    ...(body.cancel_note ? { cancel_note: body.cancel_note } : {}),
  };
}

export default app;
