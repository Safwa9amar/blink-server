import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { OrderRidersResponse } from "../../validators/merchant";
import {
  deliveriesByRider,
  distanceKm,
  fullName,
  IN_DELIVERY,
  riderEligibility,
  usersById,
} from "./orders-shared";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: riders who can take an order ──────────────────────────
// own:   the store's active drivers (invited Blink riders + external ones)
// blink: Blink riders online in the app, nearest first when positions are known
// suggested: the auto-match pick (nearest available Blink rider who neither
//        declined this order nor is already asked for it)
// Riders with the app (Blink riders, the store's app drivers) get the status
// the assign request checks (riderEligibility). `status` keeps to available |
// busy | offline because installed app builds crash on any other value;
// requested / declined say how each one stands with this order.
const route = createRoute({
  method: "get",
  path: "/orders/{id}/riders",
  operationId: "listOrderRiders",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(OrderRidersResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

// ~25 km/h average city speed for the ETA.
const etaMin = (km: number | null) => (km === null ? null : Math.max(2, Math.round((km / 25) * 60)));
const STALE_MS = 30 * 60 * 1000;

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("id, store_id")
    .eq("id", id)
    .maybeSingle();
  const store = order?.store_id ? await ownedStore(user.id, order.store_id) : null;
  if (!order || !store) return c.json({ error: "Order not found" }, 404);
  const sLat = store.latitude as number | null;
  const sLng = store.longitude as number | null;

  const [{ data: drivers }, { data: busyOrders }, { data: profiles }, { data: riderUsers }] = await Promise.all([
    supabaseAdmin
      .from("store_drivers")
      .select("*")
      .eq("store_id", store.id)
      .eq("status", "active"),
    // External drivers have no app: busy while they hold one of the store's jobs.
    supabaseAdmin
      .from("orders")
      .select("store_driver_id")
      .in("status", IN_DELIVERY)
      .not("store_driver_id", "is", null),
    supabaseAdmin
      .from("rider_profiles")
      .select("user_id, vehicle_type, latitude, longitude, location_updated_at"),
    supabaseAdmin
      .from("users")
      .select("id, first_name, last_name, phone_number, profile_picture")
      .eq("role", "rider"),
  ]);

  const busyDrivers = new Set((busyOrders ?? []).map((o) => o.store_driver_id).filter(Boolean));
  const profileByUser = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  const riderIds = (riderUsers ?? []).map((r) => r.id as string);
  const appDriverIds = (drivers ?? []).map((d) => d.rider_user_id as string | null).filter((x): x is string => !!x);
  const [deliveries, usersMap, eligibility] = await Promise.all([
    deliveriesByRider(riderIds),
    usersById(appDriverIds),
    riderEligibility([...riderIds, ...appDriverIds], { orderId: id }),
  ]);

  const distanceTo = (p?: { latitude: number | null; longitude: number | null; location_updated_at: string | null }) => {
    if (!p?.latitude || !p.longitude || sLat == null || sLng == null) return null;
    return Math.round(distanceKm(sLat, sLng, p.latitude, p.longitude) * 10) / 10;
  };

  const own = (drivers ?? []).map((d) => {
    const p = d.rider_user_id ? profileByUser.get(d.rider_user_id) : undefined;
    const km = distanceTo(p);
    const u = d.rider_user_id ? usersMap.get(d.rider_user_id) : undefined;
    const e = d.rider_user_id ? eligibility.get(d.rider_user_id) : undefined;
    return {
      id: d.id,
      kind: d.kind === "blink" ? ("own_blink" as const) : ("external" as const),
      name: d.full_name,
      phone: d.phone,
      avatar: u?.profile_picture ?? null,
      vehicle_type: d.vehicle_type ?? p?.vehicle_type ?? null,
      plate: d.plate_number,
      deliveries: d.rider_user_id ? deliveries.get(d.rider_user_id) ?? 0 : 0,
      distance_km: km,
      eta_min: etaMin(km),
      // An app driver answers a request like any Blink rider; an external
      // driver is assigned at once, so only their running job counts.
      status: d.rider_user_id
        ? e?.availability ?? ("offline" as const)
        : busyDrivers.has(d.id)
          ? ("busy" as const)
          : ("available" as const),
      requested: !!e?.requestedHere,
      declined: !!e?.declined,
    };
  });

  const ranked = (riderUsers ?? [])
    .map((r) => {
      const p = profileByUser.get(r.id);
      const km = distanceTo(p);
      const e = eligibility.get(r.id);
      const fresh = p?.location_updated_at
        ? Date.now() - new Date(p.location_updated_at).getTime() < STALE_MS
        : false;
      return {
        id: r.id,
        kind: "blink" as const,
        name: fullName(r) ?? "Blink rider",
        phone: r.phone_number,
        avatar: r.profile_picture,
        vehicle_type: p?.vehicle_type ?? null,
        plate: null,
        deliveries: deliveries.get(r.id) ?? 0,
        distance_km: km,
        eta_min: etaMin(km),
        status: e?.availability ?? ("offline" as const),
        requested: !!e?.requestedHere,
        declined: !!e?.declined,
        fresh,
      };
    })
    .filter((r) => r.status !== "offline")
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "available" ? -1 : 1;
      if (a.fresh !== b.fresh) return a.fresh ? -1 : 1;
      if (a.distance_km !== null && b.distance_km !== null) return a.distance_km - b.distance_km;
      if (a.distance_km !== null) return -1;
      if (b.distance_km !== null) return 1;
      return b.deliveries - a.deliveries;
    })
    .map(({ fresh: _fresh, ...r }) => r);

  const blink = ranked.slice(0, 20);
  // From the whole ranking, so riders who declined can't crowd it out of the top 20.
  const suggested = ranked.find((r) => r.status === "available" && !r.declined && !r.requested) ?? null;
  return c.json({ own, blink, suggested }, 200);
});

export default app;
