import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantOrderDetailResponse } from "../../validators/merchant";
import { deliveriesByRider, enrichOrders, fullName } from "./orders-shared";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: one order with customer / rider / driver / timeline ───
const route = createRoute({
  method: "get",
  path: "/orders/{id}",
  operationId: "getMerchantOrder",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(MerchantOrderDetailResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

const PRIVACY_MS = 48 * 60 * 60 * 1000;

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data: row } = await supabaseAdmin.from("orders").select("*").eq("id", id).maybeSingle();
  const store = row?.store_id ? await ownedStore(user.id, row.store_id) : null;
  if (!row || !store) return c.json({ error: "Order not found" }, 404);

  const [order] = await enrichOrders([row]);
  const closedAt = row.delivered_at ?? row.canceled_at;
  const contactsHidden = !!closedAt && Date.now() - new Date(closedAt).getTime() > PRIVACY_MS;
  const hide = (v: string | null) => (contactsHidden ? null : v);

  const [{ data: users }, { count: customerOrders }, driverRes, vehicleRes, riderProfileRes] =
    await Promise.all([
      supabaseAdmin
        .from("users")
        .select("id, first_name, last_name, phone_number, profile_picture")
        .in("id", [row.customer_id, row.rider_id].filter(Boolean)),
      supabaseAdmin
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("customer_id", row.customer_id)
        .eq("store_id", row.store_id),
      row.store_driver_id
        ? supabaseAdmin.from("store_drivers").select("*").eq("id", row.store_driver_id).maybeSingle()
        : Promise.resolve({ data: null }),
      row.rider_id
        ? supabaseAdmin.from("vehicles").select("license_plate").eq("user_id", row.rider_id).maybeSingle()
        : Promise.resolve({ data: null }),
      row.rider_id
        ? supabaseAdmin.from("rider_profiles").select("vehicle_type").eq("user_id", row.rider_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

  const customer = users?.find((u) => u.id === row.customer_id);
  const rider = row.rider_id ? users?.find((u) => u.id === row.rider_id) : undefined;
  const deliveries = rider ? (await deliveriesByRider([rider.id])).get(rider.id) ?? 0 : 0;
  const driver = driverRes.data as Record<string, any> | null;

  const canceled = row.status === "canceled" || row.status === "merchant_rejected";
  const timeline = [
    { key: "placed" as const, at: row.created_at },
    { key: "accepted" as const, at: row.accepted_at },
    { key: "prepared" as const, at: row.prepared_at },
    { key: "rider_assigned" as const, at: row.rider_assigned_at },
    { key: "picked_up" as const, at: row.picked_up_at },
    canceled
      ? { key: "canceled" as const, at: row.canceled_at ?? row.updated_at }
      : { key: "delivered" as const, at: row.delivered_at },
  ];

  return c.json(
    {
      order: order as any,
      store: {
        id: store.id,
        name: store.name,
        image: (store.image as string) ?? "",
        address: (store.location as string) ?? null,
        latitude: (store.latitude as number) ?? null,
        longitude: (store.longitude as number) ?? null,
      },
      customer: customer
        ? {
            id: customer.id,
            name: fullName(customer) ?? "Customer",
            phone: hide(customer.phone_number),
            avatar: customer.profile_picture,
            orders_count: customerOrders ?? 0,
          }
        : null,
      rider: rider
        ? {
            id: rider.id,
            name: fullName(rider) ?? "Rider",
            phone: hide(rider.phone_number),
            avatar: rider.profile_picture,
            vehicle_type: (riderProfileRes.data as any)?.vehicle_type ?? null,
            plate: (vehicleRes.data as any)?.license_plate ?? null,
            deliveries,
          }
        : null,
      driver: driver
        ? {
            id: driver.id,
            name: driver.full_name,
            phone: hide(driver.phone),
            avatar: null,
            vehicle_type: driver.vehicle_type,
            plate: driver.plate_number,
          }
        : null,
      contacts_hidden: contactsHidden,
      // Pack lines carry pack_id (and their contents in pack_items).
      pack_names: (row.items ?? [])
        .filter((it: { pack_id?: string | null }) => !!it.pack_id)
        .map((it: { name: string }) => it.name),
      // The merchant keeps the goods subtotal; fees are Blink's.
      earnings: canceled ? 0 : Number(row.subtotal),
      timeline,
    },
    200
  );
});

export default app;
