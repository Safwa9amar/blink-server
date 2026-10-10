// Rider dispatch helpers shared by /riders/jobs/*, /riders/wallet and
// /riders/location: which orders a rider may be offered, the order → RiderJob
// view, releasing a rider's pending store requests, and the Blink Cash
// balance derived from transactions + trips.
import { distanceKm, fullName, IN_DELIVERY, usersById } from "../routes/merchant/orders-shared";
import { orderRef } from "../routes/merchant/shared";
import { bundleMembers, bundleStatus, leadOrder, orderStops } from "./bundle";
import { blinkFundedDiscount, CASH_FARE_TYPES, COMMISSION_RATE, tripPayout, tripWalletDelta } from "./cash-jobs";
import { courierCopy, courierHref, type CourierEvent } from "./courier-copy";
import { courierOf, currentDropOffIndex } from "./courier";
import { createNotification } from "./notifications";
import { rideCopy, rideHref, type RideEvent } from "./ride-copy";
import { rideOf, ridePassenger } from "./ride";
import { heldSinceIso, requestFields } from "./rider-offer";
import { supabaseAdmin } from "./supabase";

/** Blink's cut of each delivery fee (src/lib/cash-jobs.ts). */
export { COMMISSION_RATE };
/** Charged when a rider drops a job after accepting it (design: "200 DA"). */
export const POST_ACCEPT_PENALTY = 200;
/** Offers are limited to pickups within this radius when the rider's position is known. */
export const OFFER_RADIUS_KM = 15;
/**
 * Only orders that went live this recently are offered (created, or accepted /
 * prepared by the merchant). Older unclaimed `searching` orders — seed data,
 * abandoned requests — are never pushed to riders.
 */
export const OFFER_MAX_AGE_MS = 20 * 60 * 1000;
/** Average urban speed used for ETA estimates. */
const AVG_SPEED_KMH = 25;
/** A courier rider's time at each drop-off (handover). */
const COURIER_STOP_MINUTES = 3;
/** A booked scheduled job this close to another one is a conflict. */
const CONFLICT_WINDOW_MS = 60 * 60 * 1000;

export { IN_DELIVERY };

type Row = Record<string, any>;

// owner_id: who to push when a rider answers a store's request. The embed is
// only read server-side — RiderJob views copy individual fields.
export const ORDER_SELECT =
  "*, store:stores(name, location, latitude, longitude, phone, owner_id)";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pickup point — the order's own, else the store's. */
export function pickupOf(o: Row) {
  const c = courierOf(o);
  if (c) return { label: c.pickup.label, address: c.pickup.address, lat: c.pickup.lat, lng: c.pickup.lng };
  const r = rideOf(o);
  if (r) return { label: r.pickup.label, address: r.pickup.address, lat: r.pickup.lat, lng: r.pickup.lng };
  return {
    // Courier and ride orders have no store ("Courier" / "Ride" are placeholder names).
    label: o.type === "courier" || o.type === "ride" ? o.pickup_address ?? "" : o.store_name ?? "",
    address: o.pickup_address ?? o.store?.location ?? o.store_name ?? "",
    lat: o.pickup_lat ?? o.store?.latitude ?? null,
    lng: o.pickup_lng ?? o.store?.longitude ?? null,
  };
}

/**
 * Drop-off point. A courier route has several: `current` = the one the rider
 * is heading to (job views), otherwise the last one (trips, totals).
 */
function destinationOf(o: Row, opts: { current?: boolean } = {}) {
  const c = courierOf(o);
  if (c?.drop_offs.length) {
    const d = c.drop_offs[(opts.current ? currentDropOffIndex(c) : null) ?? c.drop_offs.length - 1];
    return { label: d.label, address: d.address, lat: d.lat, lng: d.lng };
  }
  const r = rideOf(o);
  if (r) {
    const d = r.destination;
    return { label: d.label, address: d.address, lat: d.lat, lng: d.lng };
  }
  return {
    label: o.destination_address ?? "",
    address: o.destination_address ?? "",
    lat: o.destination_lat ?? null,
    lng: o.destination_lng ?? null,
  };
}

const kmBetween = (
  a: { lat: number | null; lng: number | null },
  b: { lat: number | null; lng: number | null }
) =>
  a.lat != null && a.lng != null && b.lat != null && b.lng != null
    ? distanceKm(a.lat, a.lng, b.lat, b.lng)
    : null;

/**
 * Single orders a rider may be offered (unassigned, waiting for a Blink rider).
 * A multi-store checkout member is never offered alone — the whole checkout
 * is one job (`isBundleOfferable` in ./bundle).
 */
export function isOfferable(o: Row) {
  if (o.checkout_id || o.rider_id || o.status !== "searching") return false;
  if (o.type === "merchant") {
    return ["accepted", "ready"].includes(o.merchant_status ?? "") && o.delivery_mode !== "own";
  }
  return true;
}

/**
 * Live enough to offer: recent, or a scheduled order still ahead (or due
 * within the window — it went live at its scheduled time).
 */
export function isFreshOffer(o: Row, now = Date.now()) {
  if (o.scheduled_at && new Date(o.scheduled_at).getTime() > now) return true;
  const liveAt = Math.max(
    ...[o.created_at, o.accepted_at, o.prepared_at, o.scheduled_at]
      .filter(Boolean)
      .map((d: string) => new Date(d).getTime())
  );
  return now - liveAt <= OFFER_MAX_AGE_MS;
}

/** users.gender of a rider (rides a customer reserved for a female rider). */
export async function riderGender(riderId: string) {
  const { data } = await supabaseAdmin.from("users").select("gender").eq("id", riderId).maybeSingle();
  return (data?.gender as string | null) ?? null;
}

export async function riderPosition(riderId: string) {
  const { data } = await supabaseAdmin
    .from("rider_profiles")
    .select("is_available, latitude, longitude, vehicle_type")
    .eq("user_id", riderId)
    .maybeSingle();
  return {
    isAvailable: data?.is_available ?? false,
    vehicleType: (data?.vehicle_type as string | null) ?? null,
    lat: (data?.latitude as number | null) ?? null,
    lng: (data?.longitude as number | null) ?? null,
  };
}

/** Customer rating (avg of riders' ratings) + delivered order count. */
async function customerStats(customerIds: string[]) {
  const ids = [...new Set(customerIds)];
  const stats = new Map<string, { rating: number | null; trips: number }>();
  if (!ids.length) return stats;
  const [{ data: rated }, { data: delivered }] = await Promise.all([
    supabaseAdmin
      .from("trips")
      .select("customer_id, customer_rating")
      .in("customer_id", ids)
      .not("customer_rating", "is", null),
    supabaseAdmin.from("orders").select("customer_id").in("customer_id", ids).eq("status", "delivered"),
  ]);
  for (const id of ids) {
    const r = (rated ?? []).filter((t) => t.customer_id === id).map((t) => t.customer_rating as number);
    stats.set(id, {
      rating: r.length ? round1(r.reduce((s, x) => s + x, 0) / r.length) : null,
      trips: (delivered ?? []).filter((d) => d.customer_id === id).length,
    });
  }
  return stats;
}

/** Available riders near a point (shown on the offer as "N riders nearby"). */
async function nearbyRiderCount(point: { lat: number | null; lng: number | null }) {
  const { data } = await supabaseAdmin
    .from("rider_profiles")
    .select("latitude, longitude")
    .eq("is_available", true);
  return (data ?? []).filter((p) => {
    const km = kmBetween(point, { lat: p.latitude, lng: p.longitude });
    return km != null && km <= OFFER_RADIUS_KM;
  }).length;
}

type JobCtx = {
  rider: { lat: number | null; lng: number | null };
  withNearby?: boolean;
  conflicts?: Map<string, Row>;
  /** The rider looking: only their own live store request fills request_kind. */
  viewerId?: string;
  /** Server clock for the request fields (default: Date.now()). */
  now?: number;
};

/** Order rows → RiderJob views. */
export async function toJobs(orders: Row[], ctx: JobCtx) {
  if (!orders.length) return [];
  const now = ctx.now ?? Date.now();
  const [users, stats, { data: trips }] = await Promise.all([
    usersById(orders.map((o) => o.customer_id)),
    customerStats(orders.map((o) => o.customer_id)),
    supabaseAdmin.from("trips").select("id, order_id").in("order_id", orders.map((o) => o.id)),
  ]);
  const tripByOrder = new Map((trips ?? []).map((t) => [t.order_id, t.id as string]));

  return Promise.all(
    orders.map(async (o) => {
      const pickup = pickupOf(o);
      const destination = destinationOf(o, { current: true });
      const courier = courierOf(o);
      const ride = rideOf(o);
      // A courier route: the whole route as priced, stops included. A ride: as priced.
      const distance = courier ? courier.distance_km : ride ? ride.distance_km : (kmBetween(pickup, destination) ?? 0);
      const customer = users.get(o.customer_id);
      const stat = stats.get(o.customer_id);
      const conflict = ctx.conflicts?.get(o.id);
      return {
        id: o.id as string,
        display_id: orderRef(o.id),
        type: o.type,
        status: o.status as string,
        store_name: o.store_name ?? "",
        customer: {
          name: fullName(customer) ?? "Customer",
          phone: customer?.phone_number ?? null,
          avatar: customer?.profile_picture ?? null,
          rating: stat?.rating ?? null,
          total_trips: stat?.trips ?? 0,
        },
        pickup,
        destination,
        fare: Number(o.delivery_fee ?? 0),
        discount: Number(o.discount ?? 0),
        order_total: Number(o.total ?? 0),
        commission_rate: COMMISSION_RATE,
        distance_km: round1(distance),
        duration_minutes: ride
          ? ride.duration_minutes
          : Math.max(
              1,
              Math.round((distance / AVG_SPEED_KMH) * 60) + (courier ? courier.drop_offs.length * COURIER_STOP_MINUTES : 0)
            ),
        pickup_distance_km: (() => {
          const km = kmBetween(ctx.rider, pickup);
          return km == null ? null : round1(km);
        })(),
        vehicle_type: o.vehicle_type ?? null,
        scheduled_at: o.scheduled_at ?? null,
        nearby_riders: ctx.withNearby ? await nearbyRiderCount(pickup) : 0,
        trip_id: tripByOrder.get(o.id) ?? null,
        conflict_with: conflict
          ? {
              id: conflict.id,
              display_id: orderRef(conflict.id),
              scheduled_at: conflict.scheduled_at,
              pickup_address: pickupOf(conflict).address,
            }
          : null,
        checkout_id: null as string | null,
        stops: [] as JobStop[],
        // A store asked this rider by name: the offer sheet shows the request
        // and its countdown. Null on every other job.
        ...requestFields(o, ctx.viewerId, now),
        // Survives the answer (request_kind is cleared on accept): the rider
        // app tells an own-store delivery (no Blink fee / penalty) from a
        // Blink one after a restart too.
        delivery_mode: o.delivery_mode === "own" || o.delivery_mode === "blink" ? (o.delivery_mode as "own" | "blink") : null,
        // Parcel, contacts and every drop-off; null for store orders.
        courier: courier
          ? {
              parcel: courier.parcel,
              paid_by: courier.paid_by,
              pickup: courier.pickup,
              drop_offs: courier.drop_offs,
              current_drop_off: currentDropOffIndex(courier),
            }
          : null,
        // Who to pick up (the customer unless they booked for someone else);
        // null for every other job.
        ride: ride
          ? (() => {
              const passenger = ridePassenger(ride, {
                name: fullName(customer) ?? null,
                phone: customer?.phone_number ?? null,
              });
              return {
                passenger_name: passenger.name,
                passenger_phone: passenger.phone,
                for_someone_else: passenger.for_someone_else,
                pickup_note: ride.pickup.note ?? null,
                arrived_at: ride.arrived_at ?? null,
                female_rider_only: ride.female_rider_only === true,
              };
            })()
          : null,
      };
    })
  );
}

type JobStop = {
  order_id: string;
  display_id: string;
  store_name: string;
  type: "merchant" | "shopper";
  pickup: ReturnType<typeof pickupOf>;
  phone: string | null;
  item_count: number;
  merchant_status: string | null;
  status: string;
  picked_up: boolean;
};

/** Every order of a multi-store checkout (rejected / canceled included). */
export async function loadBundle(checkoutId: string): Promise<Row[]> {
  const { data } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("checkout_id", checkoutId)
    .order("created_at", { ascending: true });
  return data ?? [];
}

/** Stops in route order + the route length (first stop → … → drop-off). */
function bundleRoute(members: Row[], from: { lat: number | null; lng: number | null } | null) {
  const points = members.map((o) => ({ o, ...pickupOf(o), picked_up_at: o.picked_up_at ?? null }));
  const ordered = orderStops(points, from);
  const destination = destinationOf(leadOrder(members));
  let distance = 0;
  ordered.forEach((p, i) => {
    const next = i + 1 < ordered.length ? ordered[i + 1] : destination;
    distance += kmBetween(p, next) ?? 0;
  });
  return { ordered, destination, distance };
}

const itemCount = (o: Row) =>
  (Array.isArray(o.items) ? o.items : []).reduce((n: number, i: Row) => n + Number(i.quantity ?? 0), 0);

const sumOf = (rows: Row[], key: string) => rows.reduce((n, o) => n + Number(o[key] ?? 0), 0);

/**
 * A multi-store checkout as ONE RiderJob: id = the lead order, one drop-off,
 * `stops` in route order, fare / totals summed over the members.
 */
export async function toBundleJob(rows: Row[], ctx: JobCtx) {
  const members = bundleMembers(rows);
  const lead = leadOrder(members);
  const [[base], { data: trips }] = await Promise.all([
    toJobs([lead], ctx),
    supabaseAdmin
      .from("trips")
      .select("id, order_id")
      .in("order_id", members.map((o) => o.id)),
  ]);
  // Once a rider holds the checkout, order from a fixed origin so the stop
  // numbering doesn't reshuffle as the rider moves.
  const accepted = members.some((o) => o.rider_id);
  const { ordered, distance } = bundleRoute(members, accepted ? null : ctx.rider);
  const stops: JobStop[] = ordered.map(({ o, label, address, lat, lng }) => ({
    order_id: o.id,
    display_id: orderRef(o.id),
    store_name: o.store_name ?? "",
    type: o.type === "shopper" ? "shopper" : "merchant",
    pickup: { label, address, lat, lng },
    phone: o.store?.phone ?? null,
    item_count: itemCount(o),
    merchant_status: o.merchant_status ?? null,
    status: o.status,
    picked_up: o.status === "on_the_way" || o.status === "delivered",
  }));
  // Distance to the nearest stop still to collect (the drop-off once all are).
  const ahead = stops.filter((s) => !s.picked_up).map((s) => s.pickup);
  const riderKms = (ahead.length ? ahead : [destinationOf(lead)])
    .map((p) => kmBetween(ctx.rider, p))
    .filter((k): k is number => k != null);
  return {
    ...base,
    status: bundleStatus(members),
    store_name: stops.map((s) => s.store_name).join(", "),
    pickup: stops[0]?.pickup ?? base.pickup,
    fare: sumOf(members, "delivery_fee"),
    discount: sumOf(members, "discount"),
    order_total: sumOf(members, "total"),
    distance_km: round1(distance),
    duration_minutes: Math.max(1, Math.round((distance / AVG_SPEED_KMH) * 60)),
    pickup_distance_km: riderKms.length ? round1(Math.min(...riderKms)) : null,
    trip_id: (trips ?? [])[0]?.id ?? base.trip_id,
    checkout_id: lead.checkout_id as string,
    stops,
    // request_kind / request_expires_at come from the lead (toJobs): a store's
    // own-driver request lives on every member, so the lead carries it too.
    delivery_mode:
      lead.delivery_mode === "own"
        ? ("own" as const)
        : members.some((m) => m.rider_id)
          ? ("blink" as const)
          : null,
  };
}

/** The rider's in-progress job (heading to pickup → on the way), if any. */
export async function currentJobRow(riderId: string) {
  const { data } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("rider_id", riderId)
    .in("status", IN_DELIVERY)
    .order("rider_assigned_at", { ascending: false, nullsFirst: false })
    .limit(1);
  return data?.[0] ?? null;
}

/** Scheduled jobs the rider booked but hasn't started (still `searching`). */
export async function bookedJobRows(riderId: string) {
  const { data } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("rider_id", riderId)
    .eq("status", "searching")
    .order("scheduled_at", { ascending: true });
  return data ?? [];
}

/** A booked job within an hour of `scheduledAt`, if any. */
export function findConflict(booked: Row[], scheduledAt: string | null) {
  if (!scheduledAt) return undefined;
  const at = new Date(scheduledAt).getTime();
  return booked.find(
    (b) => b.scheduled_at && Math.abs(new Date(b.scheduled_at).getTime() - at) < CONFLICT_WINDOW_MS
  );
}

/** Insert the rider's trip record for an order they just accepted. */
export async function createTripForOrder(o: Row, riderId: string) {
  const pickup = pickupOf(o);
  const destination = destinationOf(o);
  const courier = courierOf(o);
  const ride = rideOf(o);
  return upsertTrip(o, riderId, {
    pickup,
    destination,
    distance: courier ? courier.distance_km : ride ? ride.distance_km : (kmBetween(pickup, destination) ?? 0),
    fare: Number(o.delivery_fee ?? 0),
    // A ride's trip lasts what the offer said (priced estimate), not a re-estimate.
    durationMinutes: ride ? ride.duration_minutes : undefined,
  });
}

/**
 * ONE trip for a whole multi-store checkout, on the lead order: fare = the
 * stores' delivery fees, route = first store → … → drop-off.
 */
export async function createTripForBundle(rows: Row[], riderId: string) {
  const members = bundleMembers(rows);
  const { ordered, destination, distance } = bundleRoute(members, null);
  const first = ordered[0];
  return upsertTrip(leadOrder(members), riderId, {
    pickup: {
      label:
        ordered.length > 1
          ? `${first.label || first.address} +${ordered.length - 1}`
          : first.label || first.address,
      address: first.address,
      lat: first.lat,
      lng: first.lng,
    },
    destination,
    distance,
    fare: sumOf(members, "delivery_fee"),
  });
}

async function upsertTrip(
  o: Row,
  riderId: string,
  route: {
    pickup: ReturnType<typeof pickupOf>;
    destination: ReturnType<typeof destinationOf>;
    distance: number;
    fare: number;
    /** Default: the distance at the average urban speed. */
    durationMinutes?: number;
  }
) {
  const { pickup, destination, distance, fare } = route;
  const duration =
    route.durationMinutes != null && Number.isFinite(route.durationMinutes)
      ? Math.max(1, Math.round(route.durationMinutes))
      : Math.max(1, Math.round((distance / AVG_SPEED_KMH) * 60));
  const { data, error } = await supabaseAdmin
    .from("trips")
    .upsert(
      {
        order_id: o.id,
        display_id: orderRef(o.id).replace("#", "BK-"),
        rider_id: riderId,
        customer_id: o.customer_id,
        status: "upcoming",
        pickup_label: pickup.label || pickup.address || "—",
        pickup_address: pickup.address || "—",
        pickup_lat: pickup.lat ?? 0,
        pickup_lng: pickup.lng ?? 0,
        dropoff_label: destination.label || destination.address || "—",
        dropoff_address: destination.address || "—",
        dropoff_lat: destination.lat ?? pickup.lat ?? 0,
        dropoff_lng: destination.lng ?? pickup.lng ?? 0,
        ...tripPayout(fare),
        distance_km: round1(distance),
        duration_minutes: duration,
        cancellation_reason: null,
        penalty_amount: null,
      },
      { onConflict: "order_id" }
    )
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

type Copy = { title: string; description: string };
/** In-app + push "order" notification to the customer (best effort). */
export const notifyCustomer = (userId: string, en: Copy, fr: Copy, ar: Copy) =>
  createNotification({ userId, type: "order", ...en, contentFr: fr, contentAr: ar }).catch(() => null);

/** A courier event to the customer; tapping it opens the tracking screen (best effort). */
export function notifyCourier(o: { id: string; customer_id: string }, event: CourierEvent) {
  const { en, fr, ar } = courierCopy(orderRef(o.id), event);
  return createNotification({
    userId: o.customer_id,
    type: "courier",
    ...en,
    contentFr: fr,
    contentAr: ar,
    href: courierHref(o.id),
  }).catch(() => null);
}

/** A ride event to the customer; tapping it opens the ride's tracking screen (best effort). */
export function notifyRide(o: { id: string; customer_id: string }, event: RideEvent) {
  const { en, fr, ar } = rideCopy(orderRef(o.id), event);
  return createNotification({
    userId: o.customer_id,
    type: "ride",
    ...en,
    contentFr: fr,
    contentAr: ar,
    href: rideHref(o.id),
  }).catch(() => null);
}

/** Who a courier drop-off goes to, for customer copy: the recipient, else the place. */
export function dropOffName(o: Row, index?: number | null) {
  const c = courierOf(o);
  const d = c?.drop_offs[index ?? (c ? (currentDropOffIndex(c) ?? c.drop_offs.length - 1) : 0)];
  return d?.recipient_name || d?.label || d?.address || o.destination_address || "";
}

/** The same to a store owner; tapping it opens that order (best effort, no-op without an owner). */
export const notifyStoreOwner = (
  ownerId: string | null | undefined,
  orderId: string,
  en: Copy,
  fr: Copy,
  ar: Copy
) =>
  ownerId
    ? createNotification({
        userId: ownerId,
        type: "order",
        ...en,
        contentFr: fr,
        contentAr: ar,
        href: `/(merchant)/orders/${orderId}`,
      }).catch(() => null)
    : Promise.resolve(null);

/** A rider's name for store-facing copy, per language ("Your rider" when unnamed). */
export async function riderNames(riderId: string) {
  const name = fullName((await usersById([riderId])).get(riderId));
  return { en: name ?? "Your rider", fr: name ?? "Votre livreur", ar: name ?? "السائق" };
}

/**
 * Answer "can't take it" to every store request this rider still holds (they
 * went offline or took another job), so those stores can pick another rider
 * now instead of waiting out the TTL + grace. `keepOrderId`: the order the
 * rider just took. One conditional update, so a request accepted, withdrawn
 * or already answered meanwhile is left alone. Best effort: never throws.
 */
export async function releaseRiderRequests(riderId: string, opts: { keepOrderId?: string } = {}) {
  try {
    const now = Date.now();
    let held = supabaseAdmin
      .from("orders")
      .update({ offer_declined_at: new Date(now).toISOString() })
      .eq("offered_rider_id", riderId)
      .is("rider_id", null)
      .eq("status", "searching")
      .is("offer_declined_at", null)
      .gt("offered_at", heldSinceIso(now));
    if (opts.keepOrderId) held = held.neq("id", opts.keepOrderId);
    const { data: released, error } = await held.select("id, store_id");
    if (error) throw new Error(error.message);
    if (!released?.length) return;

    const [{ data: stores }, names] = await Promise.all([
      supabaseAdmin
        .from("stores")
        .select("id, owner_id")
        .in("id", [...new Set(released.map((o) => o.store_id).filter(Boolean))]),
      riderNames(riderId),
    ]);
    const ownerOf = new Map((stores ?? []).map((s) => [s.id as string, s.owner_id as string | null]));
    await Promise.all(
      released.map((o) => {
        const ref = orderRef(o.id);
        return notifyStoreOwner(
          ownerOf.get(o.store_id),
          o.id,
          { title: "Choose another rider", description: `${names.en} can't take order ${ref} right now.` },
          {
            title: "Choisissez un autre livreur",
            description: `${names.fr} ne peut pas prendre la commande ${ref} pour le moment.`,
          },
          { title: "اختر سائقًا آخر", description: `لا يستطيع ${names.ar} أخذ الطلب ${ref} الآن.` }
        );
      })
    );
  } catch (e) {
    console.error("[dispatch] releasing rider requests failed", (e as Error).message);
  }
}

/**
 * Blink Cash balance derived from transactions, trips and challenge rewards
 * (no wallet table). A completed trip charges Blink's commission, minus the
 * coupon discount Blink funds on a cash job (courier / ride: the rider
 * collected fare − discount) — see tripWalletDelta in src/lib/cash-jobs.ts.
 */
export async function riderWallet(riderId: string) {
  const [{ data: txs }, { data: trips }, { data: rewards }, { data: discounted }] = await Promise.all([
    supabaseAdmin
      .from("transactions")
      .select("type, status, amount")
      .eq("user_id", riderId)
      .in("status", ["completed", "pending"]),
    supabaseAdmin
      .from("trips")
      .select("status, estimated_payout, net_payout, penalty_amount, order_id")
      .eq("rider_id", riderId),
    supabaseAdmin
      .from("rider_challenge_participants")
      .select("reward_amount")
      .eq("rider_id", riderId)
      .eq("status", "won"),
    // Cash jobs this rider delivered with a coupon on them.
    supabaseAdmin
      .from("orders")
      .select("id, type, discount, delivery_fee")
      .eq("rider_id", riderId)
      .eq("status", "delivered")
      .in("type", [...CASH_FARE_TYPES])
      .gt("discount", 0),
  ]);
  const fundedDiscount = new Map((discounted ?? []).map((o) => [o.id as string, blinkFundedDiscount(o)]));
  let total = 0;
  let pending = 0;
  for (const t of txs ?? []) {
    const amount = Number(t.amount ?? 0);
    if (t.status === "completed") total += t.type === "deposit" ? amount : -amount;
    else if (t.type === "withdrawal") pending += amount;
  }
  for (const t of trips ?? []) {
    total += tripWalletDelta(t, t.order_id ? (fundedDiscount.get(t.order_id as string) ?? 0) : 0);
  }
  // Challenge rewards are credited to Blink Cash.
  for (const r of rewards ?? []) total += Number(r.reward_amount ?? 0);
  return { total, available: total - pending, pending, currency: "DZD" };
}
