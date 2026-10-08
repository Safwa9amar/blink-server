// The rider a customer sees on their trip / order (Ride Details, Order
// Details, live tracking): profile + vehicle. Never a rating — customers
// can't rate riders yet. Kept pure so it's unit-testable (rider-card.test.ts);
// rider-cards-load.ts loads the rows.

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
  /** Shared only while the delivery is under way. */
  phone: string | null;
}

const ACTIVE_ORDER_STATUSES = new Set(["searching", "heading_to_store", "preparation", "pickup", "on_the_way"]);

export const isActiveTrip = (t: Row) => t.status === "upcoming";
export const isActiveOrder = (o: Row) => !!o.rider_id && ACTIVE_ORDER_STATUSES.has(o.status);

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

export function buildRiderCard(
  rows: { user?: Row | null; profile?: Row | null; vehicle?: Row | null; deliveries?: number },
  riderId: string,
  active: boolean
): RiderCard {
  const u = rows.user ?? {};
  return {
    id: riderId,
    display_id: text(rows.profile?.rider_id),
    name: [text(u.first_name), text(u.last_name)].filter(Boolean).join(" ") || null,
    avatar: text(u.profile_picture),
    vehicle_type: text(rows.profile?.vehicle_type),
    vehicle_color: text(rows.vehicle?.color),
    plate: text(rows.vehicle?.license_plate),
    deliveries: rows.deliveries ?? 0,
    phone: active ? text(u.phone_number) : null,
  };
}
