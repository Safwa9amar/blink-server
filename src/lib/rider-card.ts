// The rider a customer sees on their trip / order (Ride Details, Order
// Details, live tracking): profile + vehicle, their average rating from
// customers (POST /orders/{id}/rate-rider) and, while the delivery is under
// way, their phone and last known position. Kept pure so it's unit-testable
// (rider-card.test.ts); rider-cards-load.ts loads the rows.

type Row = Record<string, any>;

export interface RiderCard {
  id: string;
  /** Human-readable rider id, e.g. "BK-RR-100001". */
  display_id: string | null;
  name: string | null;
  avatar: string | null;
  /** rider_profiles.vehicle_type: bicycle | motorcycle. */
  vehicle_type: string | null;
  vehicle_color: string | null;
  plate: string | null;
  /** Orders this rider delivered. */
  deliveries: number;
  /** Average of customers' ratings (1-5, one decimal); null when unrated. */
  rating: number | null;
  /** Shared only while the delivery is under way. */
  phone: string | null;
  /** Last known position — only while the rider is driving this delivery. */
  location: { lat: number; lng: number; updated_at: string | null } | null;
}

const ACTIVE_ORDER_STATUSES = new Set(["searching", "heading_to_store", "preparation", "pickup", "on_the_way"]);

export const isActiveTrip = (t: Row) => t.status === "upcoming";
export const isActiveOrder = (o: Row) => !!o.rider_id && ACTIVE_ORDER_STATUSES.has(o.status);
/** A rider is driving it now (a booked scheduled job stays `searching` and isn't). */
export const isLiveOrder = (o: Row) => !!o.rider_id && o.status !== "searching" && ACTIVE_ORDER_STATUSES.has(o.status);

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function buildRiderCard(
  rows: { user?: Row | null; profile?: Row | null; vehicle?: Row | null; deliveries?: number; rating?: number | null },
  riderId: string,
  active: boolean,
  live = false
): RiderCard {
  const u = rows.user ?? {};
  const lat = rows.profile?.latitude;
  const lng = rows.profile?.longitude;
  return {
    id: riderId,
    display_id: text(rows.profile?.rider_id),
    name: [text(u.first_name), text(u.last_name)].filter(Boolean).join(" ") || null,
    avatar: text(u.profile_picture),
    vehicle_type: text(rows.profile?.vehicle_type),
    vehicle_color: text(rows.vehicle?.color),
    plate: text(rows.vehicle?.license_plate),
    deliveries: rows.deliveries ?? 0,
    rating: rows.rating ?? null,
    phone: active ? text(u.phone_number) : null,
    location:
      live && typeof lat === "number" && typeof lng === "number"
        ? { lat, lng, updated_at: text(rows.profile?.location_updated_at) }
        : null,
  };
}
