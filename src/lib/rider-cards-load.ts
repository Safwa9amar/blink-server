// Loads what a customer's trip / order screens show beyond the row itself:
// the rider card, a trip's fare split (from its order) and the store card.
// A fixed number of queries per call, whatever the number of rows.
import { buildRiderCard } from "./rider-card";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

const uniq = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === "string" && !!v))];

/**
 * Adds `rider` to every row with a rider_id; `active` decides phone sharing,
 * `live` the rider's position (default: never).
 */
export async function attachRiders<T extends Row>(
  rows: T[],
  active: (row: T) => boolean,
  live: (row: T) => boolean = () => false
): Promise<T[]> {
  const ids = uniq(rows.map((r) => r.rider_id));
  if (!ids.length) return rows;
  const [{ data: users }, { data: profiles }, { data: vehicles }, { data: delivered }, { data: rated }] =
    await Promise.all([
      supabaseAdmin.from("users").select("id, first_name, last_name, profile_picture, phone_number").in("id", ids),
      supabaseAdmin
        .from("rider_profiles")
        .select("user_id, rider_id, vehicle_type, latitude, longitude, location_updated_at")
        .in("user_id", ids),
      supabaseAdmin.from("vehicles").select("user_id, color, license_plate").in("user_id", ids),
      supabaseAdmin.from("orders").select("rider_id").in("rider_id", ids).eq("status", "delivered"),
      supabaseAdmin.from("orders").select("rider_id, rider_rating").in("rider_id", ids).not("rider_rating", "is", null),
    ]);
  const by = (list: Row[] | null, key: string) => new Map((list ?? []).map((x) => [x[key], x]));
  const userById = by(users, "id");
  const profileByUser = by(profiles, "user_id");
  const vehicleByUser = by(vehicles, "user_id");
  const deliveries = new Map<string, number>();
  for (const d of delivered ?? []) deliveries.set(d.rider_id, (deliveries.get(d.rider_id) ?? 0) + 1);
  const ratings = new Map<string, number[]>();
  for (const r of rated ?? []) ratings.set(r.rider_id, [...(ratings.get(r.rider_id) ?? []), Number(r.rider_rating)]);
  const ratingOf = (id: string) => {
    const list = ratings.get(id);
    return list?.length ? Math.round((list.reduce((s, x) => s + x, 0) / list.length) * 10) / 10 : null;
  };

  return rows.map((r) =>
    r.rider_id
      ? {
          ...r,
          rider: buildRiderCard(
            {
              user: userById.get(r.rider_id),
              profile: profileByUser.get(r.rider_id),
              vehicle: vehicleByUser.get(r.rider_id),
              deliveries: deliveries.get(r.rider_id),
              rating: ratingOf(r.rider_id),
            },
            r.rider_id,
            active(r),
            live(r)
          ),
        }
      : r
  );
}

/** Adds `costs` (the customer's fare split) to trips made for an order. */
export async function attachTripCosts<T extends Row>(trips: T[]): Promise<T[]> {
  const orderIds = uniq(trips.map((t) => t.order_id));
  if (!orderIds.length) return trips;
  const { data } = await supabaseAdmin
    .from("orders")
    .select("id, delivery_fee, service_fee, discount, total")
    .in("id", orderIds);
  const byId = new Map((data ?? []).map((o) => [o.id, o]));
  return trips.map((t) => {
    const o = byId.get(t.order_id);
    return o
      ? {
          ...t,
          costs: {
            delivery_fee: Number(o.delivery_fee ?? 0),
            service_fee: Number(o.service_fee ?? 0),
            discount: Number(o.discount ?? 0),
            total: Number(o.total ?? 0),
          },
        }
      : t;
  });
}

/**
 * Adds `store_info` (description + rating) to store orders, and fills
 * `store_logo` with the store's current logo — checkout doesn't snapshot one.
 */
export async function attachStoreInfo<T extends Row>(orders: T[]): Promise<T[]> {
  const storeIds = uniq(orders.map((o) => o.store_id));
  if (!storeIds.length) return orders;
  const { data } = await supabaseAdmin.from("stores").select("id, description, rating, logo").in("id", storeIds);
  const byId = new Map((data ?? []).map((s) => [s.id, s]));
  return orders.map((o) => {
    const s = byId.get(o.store_id);
    return s
      ? {
          ...o,
          store_logo: (typeof s.logo === "string" && s.logo.trim()) || o.store_logo,
          store_info: {
            description: typeof s.description === "string" && s.description.trim() ? s.description.trim() : null,
            rating: s.rating == null ? null : Number(s.rating),
          },
        }
      : o;
  });
}
