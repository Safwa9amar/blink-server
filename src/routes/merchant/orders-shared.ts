// Helpers for the merchant order endpoints: enrich order rows with the people
// involved (customer / Blink rider / store driver), pack detection and who a
// store may send a rider request to.
import { ownSiblings, ownsWholeCheckout, type SiblingRow } from "../../lib/checkout-siblings";
import { riderFitsOrder } from "../../lib/merchant-riders";
import { getVehicleClasses } from "../../lib/pricing";
import { heldRequestTargets, offerExpiresAt, offerStatus, riderAvailability } from "../../lib/rider-offer";
import { supabaseAdmin } from "../../lib/supabase";

export interface UserLite {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_number: string | null;
  profile_picture: string | null;
}

export const fullName = (u?: Pick<UserLite, "first_name" | "last_name"> | null) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || null : null;

export async function usersById(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, UserLite>();
  if (!unique.length) return map;
  const { data } = await supabaseAdmin
    .from("users")
    .select("id, first_name, last_name, phone_number, profile_picture")
    .in("id", unique);
  for (const u of (data ?? []) as UserLite[]) map.set(u.id, u);
  return map;
}

export async function driversById(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, Record<string, any>>();
  if (!unique.length) return map;
  const { data } = await supabaseAdmin.from("store_drivers").select("*").in("id", unique);
  for (const d of data ?? []) map.set(d.id, d);
  return map;
}

/** Pack names per store (any status). */
export async function packNamesByStore(storeIds: string[]) {
  const map = new Map<string, Set<string>>();
  for (const id of storeIds) map.set(id, new Set());
  if (!storeIds.length) return map;
  const { data } = await supabaseAdmin
    .from("store_packs")
    .select("store_id, name")
    .in("store_id", storeIds);
  for (const p of data ?? []) map.get(p.store_id)?.add(p.name);
  return map;
}

/** A pack sale: some line carries a `pack_id` (POST /orders writes it on pack lines). */
export const hasPack = (order: { items: { pack_id?: string | null }[] | null }) =>
  (order.items ?? []).some((it) => !!it.pack_id);

/** Every order of these checkouts, with its store's owner. */
async function checkoutRows(checkoutIds: string[]): Promise<SiblingRow[]> {
  if (!checkoutIds.length) return [];
  const { data } = await supabaseAdmin
    .from("orders")
    .select(
      "id, checkout_id, store_id, store_name, status, merchant_status, type, items, subtotal, total, accepted_at, prepared_at, rider_assigned_at, store:stores(owner_id)"
    )
    .in("checkout_id", checkoutIds);
  // A non-`*` embed is typed as an array but is an object at runtime (many-to-one).
  return (data ?? []).map(({ store, ...r }: any) => ({
    ...r,
    owner_id: (store as { owner_id?: string | null } | null)?.owner_id ?? null,
  }));
}

/** Order rows → MerchantOrder (adds names, has_pack and the rider request state). */
export async function enrichOrders<T extends Record<string, any>>(orders: T[]) {
  const now = Date.now();
  const checkoutIds = [...new Set(orders.map((o) => o.checkout_id).filter(Boolean))] as string[];
  const [users, drivers, siblingRows] = await Promise.all([
    usersById(orders.flatMap((o) => [o.customer_id, o.rider_id, o.offered_rider_id])),
    driversById(orders.flatMap((o) => [o.store_driver_id, o.offered_driver_id])),
    checkoutRows(checkoutIds),
  ]);
  return orders.map((o) => {
    const customer = users.get(o.customer_id);
    return {
      ...o,
      customer_name: fullName(customer),
      customer_avatar: customer?.profile_picture ?? null,
      rider_name: fullName(users.get(o.rider_id)),
      driver_name: o.store_driver_id ? drivers.get(o.store_driver_id)?.full_name ?? null : null,
      // Who the store asked ("waiting for <rider>"); an own request falls back
      // to the name the store gave its driver.
      offered_rider_name:
        fullName(users.get(o.offered_rider_id)) ??
        (o.offered_driver_id ? drivers.get(o.offered_driver_id)?.full_name ?? null : null),
      offer_status: offerStatus(o, now),
      offer_expires_at: offerExpiresAt(o, now),
      has_pack: hasPack(o as any),
      own_siblings: ownSiblings({ id: o.id, checkout_id: o.checkout_id ?? null }, siblingRows),
      checkout_own_only: ownsWholeCheckout({ id: o.id, checkout_id: o.checkout_id ?? null }, siblingRows),
    };
  });
}

/** Delivered-order counts per rider user id. */
export async function deliveriesByRider(riderIds: string[]) {
  const map = new Map<string, number>();
  if (!riderIds.length) return map;
  const { data } = await supabaseAdmin
    .from("orders")
    .select("rider_id")
    .in("rider_id", riderIds)
    .eq("status", "delivered");
  for (const r of data ?? []) map.set(r.rider_id, (map.get(r.rider_id) ?? 0) + 1);
  return map;
}

/** Great-circle distance in km. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Statuses during which a rider/driver is busy with an order. */
export const IN_DELIVERY = ["heading_to_store", "preparation", "pickup", "on_the_way"];

export interface RiderEligibility {
  /** Whether a store request can reach them now (riderAvailability). */
  availability: "available" | "busy" | "offline";
  /** They turned `orderId` down (rider_order_declines). */
  declined: boolean;
  /** `orderId`'s request is held for them (live, or in the accept grace). */
  requestedHere: boolean;
}

/**
 * How each rider stands for a store request on `orderId`, by the same rule as
 * the rider's offer feed: online (a missing rider_profiles row is offline),
 * not on a job, and not already answering another store's request. One query
 * per source for the whole list. Times use the server clock (`now`).
 */
export async function riderEligibility(
  riderIds: string[],
  opts: { orderId?: string; now?: number } = {}
): Promise<Map<string, RiderEligibility>> {
  const ids = [...new Set(riderIds.filter(Boolean))];
  const map = new Map<string, RiderEligibility>();
  if (!ids.length) return map;
  const { orderId } = opts;
  const now = opts.now ?? Date.now();

  const [{ data: profiles }, { data: jobs }, { data: requests }, { data: declines }] = await Promise.all([
    supabaseAdmin.from("rider_profiles").select("user_id, is_available").in("user_id", ids),
    supabaseAdmin.from("orders").select("rider_id").in("rider_id", ids).in("status", IN_DELIVERY),
    // Open requests to these riders; heldRequestTargets keeps those still held.
    supabaseAdmin
      .from("orders")
      .select("id, rider_id, status, offered_rider_id, offered_at, offer_declined_at")
      .in("offered_rider_id", ids)
      .is("rider_id", null)
      .eq("status", "searching")
      .is("offer_declined_at", null),
    orderId
      ? supabaseAdmin.from("rider_order_declines").select("rider_id").eq("order_id", orderId).in("rider_id", ids)
      : Promise.resolve({ data: [] as { rider_id: string }[] }),
  ]);

  const online = new Map((profiles ?? []).map((p) => [p.user_id as string, p.is_available as boolean | null]));
  const busy = new Set((jobs ?? []).map((o) => o.rider_id as string));
  const declined = new Set((declines ?? []).map((d) => d.rider_id as string));
  const held = heldRequestTargets(requests ?? [], orderId, now);

  for (const id of ids) {
    map.set(id, {
      availability: riderAvailability({
        isAvailable: online.get(id),
        busy: busy.has(id),
        requestedElsewhere: held.elsewhere.has(id),
      }),
      declined: declined.has(id),
      requestedHere: held.here.has(id),
    });
  }
  return map;
}

/**
 * Auto-match: the nearest Blink rider a request can reach now — available,
 * and neither declined nor already asked for `orderId`. Unknown positions rank
 * last.
 */
export async function nearestAvailableRider(
  store: Record<string, unknown>,
  // jobVehicles = orders.vehicle_type of the order: riders its class excludes are skipped.
  opts: { orderId?: string; jobVehicles?: (string | null)[] } = {}
) {
  const [{ data: riders }, { data: profiles }, classes] = await Promise.all([
    supabaseAdmin.from("users").select("id").eq("role", "rider"),
    supabaseAdmin.from("rider_profiles").select("user_id, latitude, longitude, vehicle_type, vehicle_class"),
    getVehicleClasses(),
  ]);
  const ids = (riders ?? []).map((r) => r.id as string);
  const eligibility = await riderEligibility(ids, { orderId: opts.orderId });
  const prof = new Map((profiles ?? []).map((p) => [p.user_id, p]));
  const sLat = store.latitude as number | null;
  const sLng = store.longitude as number | null;
  const ranked = ids
    .filter((id) => {
      const e = eligibility.get(id);
      return (
        e?.availability === "available" &&
        !e.declined &&
        !e.requestedHere &&
        riderFitsOrder(opts.jobVehicles ?? [], prof.get(id), classes)
      );
    })
    .map((id) => {
      const p = prof.get(id);
      const km =
        p?.latitude != null && p.longitude != null && sLat != null && sLng != null
          ? distanceKm(sLat, sLng, p.latitude, p.longitude)
          : Number.POSITIVE_INFINITY;
      return { id, km };
    })
    .sort((a, b) => a.km - b.km);
  return ranked[0] ?? null;
}

/**
 * A store hands an order to a Blink shopper: either a `too_busy` rejection
 * (PATCH /merchant/orders/{id}) or a multi-store checkout order the store left
 * unanswered (POST /cron/bundle-timeouts). A Blink rider then buys the items
 * in the store.
 */
export const SHOPPER_HANDOVER_PATCH = {
  merchant_status: "rejected",
  merchant_reject_reason: "too_busy",
  type: "shopper",
  status: "searching",
} as const;

/** The customer notification copy for a shopper hand-over. */
export const shopperHandoverCopy = (store: string, ref: string) => ({
  en: {
    title: "A Blink shopper is on it",
    description: `${store} is busy — a Blink rider will shop your order ${ref} in store.`,
  },
  fr: {
    title: "Un livreur Blink s'en charge",
    description: `${store} est occupé — un livreur Blink fera vos achats ${ref} en magasin.`,
  },
  ar: {
    title: "مندوب Blink يتكفّل بطلبك",
    description: `${store} مشغول — سيشتري مندوب Blink طلبك ${ref} من المتجر.`,
  },
});
