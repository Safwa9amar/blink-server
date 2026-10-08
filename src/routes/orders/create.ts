import { priceCoupon } from "../../lib/coupons";
import { createNotification } from "../../lib/notifications";
import { withoutOffer } from "../../lib/rider-offer";
import { LOW_STOCK } from "../merchant/strategy-shared";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createOrderSchema, OrderResponse } from "../../validators/orders";

const app = router();

// ─── Create order (customer) ─────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/",
  operationId: "createOrder",
  tags: ["orders"],
  security: bearer,
  middleware: [requireRole("customer")] as const,
  request: { body: { ...json(createOrderSchema), required: true } },
  responses: {
    201: json(OrderResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  // A marketplace order nobody can fulfil: without a store no merchant ever
  // sees it. Courier requests legitimately have no store; a multi-store cart
  // is split client-side into one order per store sharing a checkout_id.
  if (body.type === "merchant" && !body.store_id) {
    return c.json({ error: "store_id is required for merchant orders" }, 400);
  }

  // A coupon code is priced here, never trusted from the client.
  let discount = body.discount;
  let couponId: string | null = null;
  if (body.coupon_code) {
    const priced = await priceCoupon(user.id, body.coupon_code, body.subtotal, body.delivery_fee);
    if (!priced.ok) {
      return c.json({ error: `Coupon not applicable: ${priced.reason}` }, 400);
    }
    discount = priced.discount;
    couponId = priced.coupon.id;
  }

  const total = Math.max(0, body.subtotal + body.delivery_fee + body.service_fee - discount);

  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: user.id,
      store_name: body.store_name,
      store_logo: body.store_logo ?? null,
      type: body.type,
      status: body.type === "courier" ? "searching" : "processing",
      items: body.items,
      subtotal: body.subtotal,
      delivery_fee: body.delivery_fee,
      service_fee: body.service_fee,
      discount,
      store_id: body.store_id ?? null,
      merchant_status: body.store_id ? "pending" : null,
      coupon_id: couponId,
      // Only sent when given, so single orders keep working on a DB that
      // predates 00040_order_checkout_group.sql.
      ...(body.checkout_id ? { checkout_id: body.checkout_id } : {}),
      total,
      pickup_address: body.pickup_address ?? null,
      destination_address: body.destination_address ?? null,
      pickup_lat: body.pickup_lat ?? null,
      pickup_lng: body.pickup_lng ?? null,
      destination_lat: body.destination_lat ?? null,
      destination_lng: body.destination_lng ?? null,
      vehicle_type: body.vehicle_type ?? null,
      scheduled_at: body.scheduled_at ?? null,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  if (couponId) {
    await supabaseAdmin
      .from("customer_coupons")
      .update({ used_at: new Date().toISOString(), order_id: data.id })
      .eq("id", couponId);
  }

  // Decrement stock for the store's products in this order; alert the
  // merchant when an item runs low.
  if (body.store_id) {
    await decrementStock(body.store_id, body.items).catch(() => null);
  }

  // Tell the store's merchant a new order is waiting for them.
  if (body.store_id) {
    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("owner_id")
      .eq("id", body.store_id)
      .maybeSingle();
    if (store?.owner_id) {
      const ref = `#${data.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await createNotification({
        userId: store.owner_id,
        type: "order",
        title: "New order",
        description: `${body.store_name}: order ${ref} is waiting for you.`,
        contentFr: {
          title: "Nouvelle commande",
          description: `${body.store_name} : la commande ${ref} vous attend.`,
        },
        contentAr: { title: "طلب جديد", description: `${body.store_name}: الطلب ${ref} بانتظارك.` },
        href: "/(merchant)/orders",
      }).catch(() => null);
    }
  }

  return c.json({ order: withoutOffer(data) }, 201);
});

export default app;

async function decrementStock(storeId: string, items: { name: string; quantity: number }[]) {
  const names = [...new Set(items.map((i) => i.name))];
  const { data: products } = await supabaseAdmin
    .from("store_products")
    .select("id, title, stock, store:stores(owner_id, name)")
    .eq("store_id", storeId)
    .in("title", names);
  for (const p of (products ?? []) as any[]) {
    const qty = items.filter((i) => i.name === p.title).reduce((t, i) => t + i.quantity, 0);
    const stock = Math.max(0, (p.stock ?? 0) - qty);
    await supabaseAdmin.from("store_products").update({ stock }).eq("id", p.id);
    if (p.stock > LOW_STOCK && stock <= LOW_STOCK && p.store?.owner_id) {
      await createNotification({
        userId: p.store.owner_id,
        type: "alert",
        title: "Item running low",
        description: `${p.title} at ${p.store.name}: ${stock} left.`,
        contentFr: { title: "Stock faible", description: `${p.title} chez ${p.store.name} : ${stock} restant(s).` },
        contentAr: { title: "مخزون منخفض", description: `${p.title} في ${p.store.name}: تبقى ${stock}.` },
        payload: { kind: "low_stock", product_id: p.id, store_id: storeId, stock },
      }).catch(() => null);
    }
  }
}
