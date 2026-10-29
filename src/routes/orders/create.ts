import { priceCoupon } from "../../lib/coupons";
import { scheduleError } from "../../lib/courier";
import { courierFare, routeKm } from "../../lib/courier-pricing";
import { courierFareConfig, placeColumns } from "../../lib/pricing/fare-config";
import { checkoutAlreadyCharged, orderPricingContext, quoteServiceFee } from "../../lib/pricing/fees";
import { getPrices } from "../../lib/pricing";
import { deliveryFeeChanged } from "../../lib/pricing/store-delivery";
import { quoteStoreDelivery, type StoreDeliveryResult } from "../../lib/pricing/store-quote";
import { priceCourierCoupon } from "../courier/shared";
import { createNotification } from "../../lib/notifications";
import { withoutOffer } from "../../lib/rider-offer";
import { storeOpenState } from "../../lib/store-categories";
import { packStockUsage, priceStoreOrder, type CustomerPack, type PricedOrderLine } from "../../lib/pack-pricing";
import { priceProductLines, productStockUsage } from "../../lib/product-pricing";
import { loadOrderableStoreProducts } from "../../lib/store-products";
import { loadVisiblePacks } from "../../lib/store-packs";
import { LOW_STOCK } from "../merchant/strategy-shared";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { z } from "@hono/zod-openapi";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { createOrderSchema, OrderResponse, PackChangedError, PriceChangedError, ProductChangedError } from "../../validators/orders";
import { pushNewOffer } from "../../lib/offer-push";

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
    409: json(
      z.union([PackChangedError, ProductChangedError, PriceChangedError]),
      "Either a pack line's pack changed or is gone (code pack_changed: refetch the store's packs), a product line's product moved in price or is no longer sold (code product_changed: refresh the cart with POST /marketplace/products/lookup), or the service fee / the store's delivery fee changed since `expected_service_fee` / `expected_delivery_fee` was shown (error price_changed, with the current `service_fee` and `delivery_fee`)"
    ),
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

  // Shopper orders are only made by the server (a store that doesn't answer
  // hands over to a Blink shopper); no client creates one.
  if (body.type === "shopper") {
    return c.json({ error: "Unsupported order type" }, 400);
  }

  // A store only takes orders while it's live and open — by its weekly
  // schedule, or the merchant's manual override. The app matches the
  // "Store closed" / "Store unavailable" prefixes.
  let storeOwnerId: string | null = null;
  let storeDeliveryFee: number | null = null;
  let storePoint: { lat: number; lng: number } | null = null;
  if (body.store_id) {
    const { data: store } = await supabaseAdmin
      .from("stores")
      .select("name, owner_id, status, is_open, hours, manual_override, delivery_fee, latitude, longitude")
      .eq("id", body.store_id)
      .maybeSingle();
    if (!store || store.status !== "active") {
      return c.json({ error: "Store unavailable: this store isn't taking orders" }, 400);
    }
    if (!storeOpenState(store).is_open) {
      return c.json({ error: `Store closed: ${store.name} is closed right now` }, 400);
    }
    storeOwnerId = store.owner_id;
    storeDeliveryFee = Number(store.delivery_fee ?? 0);
    if (store.latitude != null && store.longitude != null) storePoint = { lat: Number(store.latitude), lng: Number(store.longitude) };
  }

  // Courier requests from older apps (new ones use POST /courier/requests):
  // the fee is priced here from the route, never taken from the client.
  // Every amount is the server's: the client's subtotal / delivery_fee /
  // service_fee / discount are ignored for every order type.
  let subtotal = 0;
  let deliveryFee = 0;
  // Decided by the server (pricing config `service_fee`): the client's value is
  // ignored. Once per checkout, on the first store order created for it.
  const alreadyCharged = body.type !== "courier" && (await checkoutAlreadyCharged(user.id, body.checkout_id));
  const isCourier = body.type === "courier";
  const pricingCtx = await orderPricingContext({
    type: body.type,
    storeId: body.store_id,
    lat: isCourier ? body.pickup_lat : body.destination_lat,
    lng: isCourier ? body.pickup_lng : body.destination_lng,
  });
  const fee = await quoteServiceFee(pricingCtx, { type: body.type, checkoutAlreadyCharged: alreadyCharged });
  let serviceFee = fee.amount;
  // The delivery fee of a store order (store_delivery: the merchant's own fee, or by distance
  // to the customer); the same function as POST /orders/quote, so shown = charged.
  let delivery: StoreDeliveryResult | null = null;
  if (body.type === "merchant" && body.store_id && storeDeliveryFee != null) {
    const customer =
      body.destination_lat != null && body.destination_lng != null
        ? { lat: body.destination_lat, lng: body.destination_lng }
        : null;
    delivery = await quoteStoreDelivery({ ctx: pricingCtx, merchantFee: storeDeliveryFee, store: storePoint, customer });
  }
  const pricingApplied: Record<string, string | null> = {};
  // Where the order is priced (the store, or a courier's pickup); stored on the order.
  let orderPlace = pricingCtx.place;
  let merchantCommissionRate: number | null = null;
  let stampDutyRate: number | null = null;
  if (!isCourier) {
    pricingApplied.service_fee = fee.overrideId;
    if (body.store_id) {
      const rates = await getPrices(["merchant_commission_rate", "stamp_duty_rate"] as const, pricingCtx);
      merchantCommissionRate = rates.merchant_commission_rate.value.rate;
      stampDutyRate = rates.stamp_duty_rate.value.rate;
      pricingApplied.merchant_commission_rate = rates.merchant_commission_rate.overrideId;
      pricingApplied.stamp_duty_rate = rates.stamp_duty_rate.overrideId;
    }
    // Tolerant compare (float noise), and no 409 when the server fee is 0 only
    // because this checkout already paid it (a retry of a multi-store checkout).
    const serviceChanged =
      body.expected_service_fee != null &&
      !(serviceFee === 0 && alreadyCharged) &&
      Math.abs(body.expected_service_fee - serviceFee) >= 0.005;
    // Absent from old apps: no 409 then. Compared before any free-pack waiver.
    const deliveryChanged = delivery != null && deliveryFeeChanged(body.expected_delivery_fee, delivery.fee);
    if (serviceChanged || deliveryChanged) {
      return c.json(
        {
          error: "price_changed" as const,
          service_fee: serviceFee,
          ...(delivery ? { delivery_fee: delivery.fee } : {}),
        },
        409
      );
    }
    if (delivery) Object.assign(pricingApplied, delivery.applied);
  }
  if (isCourier) {
    const vehicle = body.vehicle_type;
    if (!vehicle) return c.json({ error: "vehicle_type is required for a courier request" }, 400);
    const { pickup_lat, pickup_lng, destination_lat, destination_lng } = body;
    if (pickup_lat == null || pickup_lng == null || destination_lat == null || destination_lng == null) {
      return c.json({ error: "A courier request needs pickup and destination coordinates" }, 400);
    }
    const scheduleProblem = scheduleError(body.scheduled_at);
    if (scheduleProblem) return c.json({ error: scheduleProblem }, 400);
    const cfg = await courierFareConfig(
      { lat: pickup_lat, lng: pickup_lng },
      { lat: destination_lat, lng: destination_lng }
    );
    if (!cfg.enabled) {
      return c.json({ error: "Our courier service isn't available at this pickup yet", code: "out_of_service_area" }, 400);
    }
    const chosen = cfg.legs.find((l) => l.cls.code === vehicle);
    if (!chosen) return c.json({ error: `vehicle_type "${vehicle}" isn't an available courier option` }, 400);
    const km = routeKm({ lat: pickup_lat, lng: pickup_lng }, [{ lat: destination_lat, lng: destination_lng }], cfg.formula);
    const maxKm = chosen.leg.max_km;
    if (km > maxKm) {
      return c.json({ error: `Route too long: a ${vehicle} takes up to ${maxKm} km` }, 400);
    }
    subtotal = 0;
    deliveryFee = courierFare(vehicle, km, 1, cfg.rates, cfg.multiplier, {
      formula: cfg.formula,
      surcharge: cfg.surcharge,
      classes: cfg.legs,
    });
    serviceFee = 0;
    Object.assign(pricingApplied, cfg.appliedFor(vehicle));
    orderPlace = cfg.place;
  }

  // Store orders: every line is priced here from live data. Product lines
  // take the live product price (409 product_changed when it moved or the
  // product is gone; older apps' lines without a product_id are matched by
  // title and charged the live price); pack lines 409 pack_changed when the
  // pack is gone or its price moved. The subtotal is
  // summed from the lines and the delivery fee is the store's `store_delivery` fee. When every line
  // is a free-delivery pack the customer doesn't pay it: `deliveryWaived` is
  // taken off as a discount the merchant funds (earnings subtract discounts),
  // while `delivery_fee` stays the rider's fare (src/lib/pack-pricing.ts).
  // Other orders can't carry packs.
  let items: PricedOrderLine[] = body.items.map(({ pack_id: _packId, product_id: _productId, ...line }) => line);
  let deliveryWaived = 0;
  let packStock = new Map<string, number>();
  if (body.type === "merchant" && body.store_id && storeDeliveryFee != null) {
    const packIds = [...new Set(body.items.flatMap((i) => (i.pack_id ? [i.pack_id] : [])))];
    let packs: CustomerPack[];
    try {
      packs = await loadVisiblePacks(body.store_id, packIds);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    let lines = body.items;
    try {
      const products = await loadOrderableStoreProducts(
        body.store_id,
        [...new Set(body.items.flatMap((i) => (i.product_id && !i.pack_id ? [i.product_id] : [])))],
        [...new Set(body.items.flatMap((i) => (!i.product_id && !i.pack_id ? [i.name] : [])))]
      );
      const pricedProducts = priceProductLines(body.items, products);
      if (!pricedProducts.ok) {
        if (pricedProducts.reason === "unavailable") {
          return c.json({ error: `Product unavailable: ${pricedProducts.name}` }, 400);
        }
        return c.json(
          {
            error: "Product changed: a product in this order changed price or is no longer available",
            code: "product_changed" as const,
            products: pricedProducts.products,
          },
          409
        );
      }
      lines = pricedProducts.lines;
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
    const priced = priceStoreOrder(lines, packs, delivery?.fee ?? storeDeliveryFee);
    if (!priced.ok) {
      return c.json(
        {
          error: "Pack changed: a pack in this order changed or is no longer available",
          code: "pack_changed" as const,
          pack_id: priced.pack_id,
        },
        409
      );
    }
    items = priced.items;
    subtotal = priced.subtotal;
    deliveryFee = priced.delivery_fee;
    deliveryWaived = priced.delivery_waived;
    packStock = packStockUsage(priced.items, packs);
  }

  // A coupon code is priced here, never trusted from the client. A store
  // order's discount only ever comes from its coupon (the app sends none
  // without one), so a client can't cancel the server's fees with `discount`.
  let discount = 0;
  let couponId: string | null = null;
  if (body.coupon_code && body.type === "courier") {
    const priced = await priceCourierCoupon(user.id, body.coupon_code, deliveryFee);
    if (!priced.ok) {
      return c.json({ error: `Coupon not applicable: ${priced.reason}` }, 400);
    }
    discount = priced.discount;
    couponId = priced.coupon.id;
  } else if (body.coupon_code) {
    // Priced on the delivery the customer actually pays, so a free-delivery
    // coupon can't take a waived fee off twice.
    const priced = await priceCoupon(user.id, body.coupon_code, subtotal, deliveryFee - deliveryWaived);
    if (!priced.ok) {
      return c.json({ error: `Coupon not applicable: ${priced.reason}` }, 400);
    }
    discount = priced.discount;
    // A coupon that takes nothing off (e.g. free delivery on a store order of
    // free-delivery packs, which already ships free) isn't used up.
    couponId = priced.discount > 0 ? priced.coupon.id : null;
  }

  discount += deliveryWaived;
  const total = Math.max(0, subtotal + deliveryFee + serviceFee - discount);

  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_id: user.id,
      store_name: body.store_name,
      store_logo: body.store_logo ?? null,
      type: body.type,
      status: body.type === "courier" ? "searching" : "processing",
      items,
      subtotal,
      delivery_fee: deliveryFee,
      service_fee: serviceFee,
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
      // Courier: the class the customer picked. Store order: the class the delivery fee was
      // priced for (distance mode) so dispatch only offers it to riders who can take it; null
      // (any rider) in merchant mode. Never the client's value for a store order.
      vehicle_type: isCourier ? body.vehicle_type ?? null : delivery?.vehicle ?? null,
      scheduled_at: body.scheduled_at ?? null,
      // Rates in force at order time (snapshot): dues and payouts use these.
      merchant_commission_rate: merchantCommissionRate,
      stamp_duty_rate: stampDutyRate,
      pricing_applied: pricingApplied,
      ...(orderPlace ? placeColumns(orderPlace) : {}),
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
  // merchant when an item runs low. Everything is by product id: a product
  // line's own, plus a pack line's contents (charged + free units).
  if (body.type === "merchant" && body.store_id) {
    const usage = new Map(packStock);
    for (const [id, qty] of productStockUsage(items)) usage.set(id, (usage.get(id) ?? 0) + qty);
    await decrementStock(body.store_id, usage).catch(() => null);
  }

  // Tell the store's merchant a new order is waiting for them.
  if (storeOwnerId) {
    const ref = `#${data.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await createNotification({
      userId: storeOwnerId,
      role: "merchant",
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

  // A courier order is in the pool from the start (store orders wait for the store).
  if (data.status === "searching") void pushNewOffer(data.id);
  return c.json({ order: withoutOffer(data) }, 201);
});

export default app;

async function decrementStock(storeId: string, usage: Map<string, number>) {
  const ids = [...usage.keys()];
  if (!ids.length) return;
  const { data } = await supabaseAdmin
    .from("store_products")
    .select("id, title, stock, store:stores(owner_id, name)")
    .eq("store_id", storeId)
    .in("id", ids);
  for (const p of (data ?? []) as any[]) {
    const qty = usage.get(p.id) ?? 0;
    const stock = Math.max(0, (p.stock ?? 0) - qty);
    await supabaseAdmin.from("store_products").update({ stock }).eq("id", p.id);
    if (p.stock > LOW_STOCK && stock <= LOW_STOCK && p.store?.owner_id) {
      await createNotification({
        userId: p.store.owner_id,
        role: "merchant",
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
