import { bundleMembers } from "../../lib/bundle";
import { createNotification } from "../../lib/notifications";
import { pickedUpPatch } from "../../lib/order-steps";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  merchantOrderActionSchema,
  MerchantOrderResponse,
} from "../../validators/merchant";
import { SHOPPER_HANDOVER_PATCH, shopperHandoverCopy } from "./orders-shared";
import { orderRef, ownedStore } from "./shared";
import { pushNewOffer } from "../../lib/offer-push";

const app = router();

// ─── Merchant: act on an order ───────────────────────────────────────
// accept    pending → accepted (processing → searching for a rider)
// reject    pending → rejected with a reason. `too_busy` hands the order to a
//           Blink shopper (type → shopper, keeps going); any other reason
//           cancels it (status merchant_rejected — customer refunded).
// ready     accepted → ready (packed; next: assign a rider)
// picked_up own-driver orders: heading_to_store | preparation | pickup →
//           on_the_way. An external driver has no app to report arriving
//           (pickup), so the merchant hands over from the assignment on.
// delivered own-driver orders: → delivered
// A multi-store checkout order (`checkout_id`) is collected by ONE rider: the
// checkout's Blink rider, or — when every store in it is this merchant's — the
// merchant's own driver, whose picked_up / delivered then move every store's
// order that driver carries. Reject needs `pending`, so it can't happen once a
// rider holds the checkout.
const route = createRoute({
  method: "patch",
  path: "/orders/{id}",
  operationId: "actOnMerchantOrder",
  tags: ["merchant"],
  security: bearer,
  request: {
    params: IdParam,
    body: { ...json(merchantOrderActionSchema), required: true },
  },
  responses: {
    200: json(MerchantOrderResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

const CLOSED = new Set(["delivered", "canceled", "merchant_rejected"]);
/** Where an own-driver order can be handed over at the counter. */
const PICKUP_FROM = new Set(["heading_to_store", "preparation", "pickup"]);

type Copy = { title: string; description: string };
const notify = (userId: string, en: Copy, fr: Copy, ar: Copy) =>
  createNotification({ userId, type: "order", ...en, contentFr: fr, contentAr: ar }).catch(() => null);

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { action, reason } = c.req.valid("json");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, customer_id, store_id, store_name, status, merchant_status, delivery_mode, type, checkout_id, store_driver_id")
    .eq("id", id)
    .maybeSingle();
  if (!order?.store_id || !(await ownedStore(user.id, order.store_id))) {
    return c.json({ error: "Order not found" }, 404);
  }
  if (CLOSED.has(order.status)) {
    return c.json({ error: "Order is already closed" }, 400);
  }

  const now = new Date().toISOString();
  const current = order.merchant_status ?? "pending";
  const patch: Record<string, unknown> = {};
  const ref = orderRef(id);
  const store = order.store_name;

  // An own-driver checkout: one driver collects every store, so picked up /
  // delivered move every member that driver carries.
  if (order.checkout_id && (action === "picked_up" || action === "delivered")) {
    if (order.delivery_mode !== "own") {
      return c.json({ error: "Only orders delivered by your own rider" }, 400);
    }
    const { data: rows } = await supabaseAdmin
      .from("orders")
      .select("id, status, type, merchant_status, delivery_mode, store_driver_id")
      .eq("checkout_id", order.checkout_id);
    const members = bundleMembers(rows ?? []).filter(
      (m) => m.delivery_mode === "own" && m.store_driver_id === order.store_driver_id
    );
    if (action === "picked_up") {
      const waiting = members.filter((m) => PICKUP_FROM.has(m.status));
      if (!waiting.length) return c.json({ error: "Order is not waiting for pickup" }, 400);
      await Promise.all(
        waiting.map((m) =>
          supabaseAdmin.from("orders").update(pickedUpPatch(m, now)).eq("id", m.id).eq("status", m.status)
        )
      );
    } else {
      if (!members.every((m) => m.status === "on_the_way")) {
        return c.json({ error: "Mark every store picked up first" }, 400);
      }
      await supabaseAdmin
        .from("orders")
        .update({ status: "delivered", delivered_at: now })
        .in("id", members.map((m) => m.id))
        .eq("status", "on_the_way");
    }
    const { data: fresh } = await supabaseAdmin.from("orders").select("*").eq("id", id).maybeSingle();
    if (action === "picked_up") {
      await notify(
        order.customer_id,
        { title: "On the way", description: `Your order ${ref} is on its way.` },
        { title: "En route", description: `Votre commande ${ref} est en route.` },
        { title: "في الطريق", description: `طلبك ${ref} في الطريق.` }
      );
    } else {
      await notify(
        order.customer_id,
        { title: "Delivered", description: `Your order ${ref} was delivered. Rate it!` },
        { title: "Livrée", description: `Votre commande ${ref} a été livrée. Notez-la !` },
        { title: "تم التوصيل", description: `تم توصيل طلبك ${ref}. قيّمه!` }
      );
    }
    return c.json({ order: fresh }, 200);
  }

  switch (action) {
    case "accept":
      if (current !== "pending") return c.json({ error: "Order is not pending" }, 400);
      Object.assign(patch, { merchant_status: "accepted", accepted_at: now });
      if (order.status === "processing") patch.status = "searching";
      break;
    case "reject":
      if (current !== "pending") return c.json({ error: "Order is not pending" }, 400);
      if (reason === "too_busy") {
        // A Blink rider will shop the items in-store instead.
        Object.assign(patch, SHOPPER_HANDOVER_PATCH);
      } else {
        Object.assign(patch, {
          merchant_status: "rejected",
          merchant_reject_reason: reason,
          status: "merchant_rejected",
          canceled_at: now,
          canceled_by: "merchant",
        });
      }
      break;
    case "ready":
      if (current !== "accepted") return c.json({ error: "Order is not being prepared" }, 400);
      Object.assign(patch, { merchant_status: "ready", prepared_at: now });
      break;
    case "picked_up":
    case "delivered":
      if (order.delivery_mode !== "own") {
        return c.json({ error: "Only orders delivered by your own rider" }, 400);
      }
      if (action === "picked_up") {
        if (!PICKUP_FROM.has(order.status)) return c.json({ error: "Order is not waiting for pickup" }, 400);
        Object.assign(patch, pickedUpPatch(order, now));
      } else {
        if (order.status !== "on_the_way") return c.json({ error: "Order is not on the way" }, 400);
        Object.assign(patch, { status: "delivered", delivered_at: now });
      }
      break;
  }

  // Conditional on what was read: the bundle-timeout cron can turn a pending
  // checkout order into a shopper order at the same moment.
  let write = supabaseAdmin.from("orders").update(patch).eq("id", id).eq("status", order.status);
  write = order.merchant_status == null
    ? write.is("merchant_status", null)
    : write.eq("merchant_status", order.merchant_status);
  const { data, error } = await write.select().maybeSingle();
  if (error) return c.json({ error: error.message }, 400);
  if (!data) return c.json({ error: "Order changed, refresh and try again" }, 400);

  // Accepting (or handing over to a shopper) puts a Blink order in the pool.
  if (action === "accept" || (action === "reject" && reason === "too_busy")) void pushNewOffer(id);

  // Keep the customer in the loop.
  if (action === "accept") {
    await notify(
      order.customer_id,
      { title: "Order accepted", description: `${store} is preparing your order ${ref}.` },
      { title: "Commande acceptée", description: `${store} prépare votre commande ${ref}.` },
      { title: "تم قبول الطلب", description: `${store} يحضّر طلبك ${ref}.` }
    );
  } else if (action === "reject" && reason === "too_busy") {
    const copy = shopperHandoverCopy(store, ref);
    await notify(order.customer_id, copy.en, copy.fr, copy.ar);
  } else if (action === "reject") {
    await notify(
      order.customer_id,
      { title: "Order cancelled", description: `${store} couldn't take your order ${ref}. You'll be refunded.` },
      { title: "Commande annulée", description: `${store} n'a pas pu accepter votre commande ${ref}. Vous serez remboursé.` },
      { title: "تم إلغاء الطلب", description: `تعذّر على ${store} قبول طلبك ${ref}. سيتم استرداد المبلغ.` }
    );
  } else if (action === "picked_up") {
    await notify(
      order.customer_id,
      { title: "On the way", description: `Your order ${ref} from ${store} is on its way.` },
      { title: "En route", description: `Votre commande ${ref} de ${store} est en route.` },
      { title: "في الطريق", description: `طلبك ${ref} من ${store} في الطريق.` }
    );
  } else if (action === "delivered") {
    await notify(
      order.customer_id,
      { title: "Delivered", description: `Your order ${ref} from ${store} was delivered. Rate it!` },
      { title: "Livrée", description: `Votre commande ${ref} de ${store} a été livrée. Notez-la !` },
      { title: "تم التوصيل", description: `تم توصيل طلبك ${ref} من ${store}. قيّمه!` }
    );
  }

  return c.json({ order: data }, 200);
});

export default app;
