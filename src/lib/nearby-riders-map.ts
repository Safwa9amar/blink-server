// The free riders a customer sees on the map of the ride / courier request
// screens (POST /ride/quote, POST /courier/quote → nearby_riders_map). Pure:
// the routes load the riders (routes/courier/shared.ts freeRidersNear) and
// this picks, blurs and tokenises them.
//
// Privacy: a marker never carries the rider's user id, name or exact
// position. `id` is an opaque per-day token (HMAC of the rider id) so the app
// can key markers across re-quotes; the position is rounded to ~100 m plus a
// small per-rider offset, so riders parked together don't stack.
import { createHmac } from "node:crypto";

/** Most markers drawn, nearest first. */
export const NEARBY_MAP_MAX = 12;
/** A position older than this isn't drawn (the rider may have moved / left). */
export const NEARBY_MAP_FRESH_MS = 10 * 60_000;
/** Radius when the caller has no bound of its own. */
export const NEARBY_MAP_DEFAULT_RADIUS_KM = 5;
/** Token secret when RIDER_MAP_SALT is unset (dev). */
export const DEV_RIDER_MAP_SALT = "blink-dev-rider-map-salt";

/** A timestamp this far ahead of the server clock still counts as fresh. */
const CLOCK_SKEW_MS = 60_000;
const TOKEN_HEX = 16; // 64 bits
const METERS_PER_DEG_LAT = 111_320;
/** Per-rider offset, in metres, added on top of the ~100 m rounding. */
const OFFSET_MIN_M = 15;
const OFFSET_MAX_M = 45;

export type MapVehicle = "bicycle" | "motorcycle";

export interface NearbyRiderMarker {
  /** Opaque, stable for the day; never the rider's id. */
  id: string;
  lat: number;
  lng: number;
  vehicle_type: MapVehicle | null;
  /** Not stored for riders yet: always null. */
  heading: number | null;
}

/** A free rider as loaded by the route (exact position, straight-line km to the pickup). */
export interface MapCandidate {
  id: string;
  lat: number;
  lng: number;
  km: number;
  vehicle: string | null;
  /** rider_profiles.vehicle_class: the class staff assigned (null = the default of `vehicle`). */
  vehicleClass?: string | null;
  /** rider_profiles.location_updated_at */
  updatedAt: string | null;
}

/** Updated within `maxAgeMs` of `now` (a little clock skew ahead is tolerated). */
export function isFreshLocation(updatedAt: string | null | undefined, now: number, maxAgeMs = NEARBY_MAP_FRESH_MS) {
  if (!updatedAt) return false;
  const at = Date.parse(updatedAt);
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age <= maxAgeMs && age >= -CLOCK_SKEW_MS;
}

/**
 * The riders to draw: fresh position, within `radiusKm` (5 km when unbounded),
 * nearest first (ties by id, so the pick is stable), at most `max`.
 */
export function selectMapRiders<T extends MapCandidate>(
  riders: readonly T[],
  opts: { now: number; radiusKm?: number | null; max?: number }
): T[] {
  const radius =
    opts.radiusKm != null && Number.isFinite(opts.radiusKm) && opts.radiusKm > 0
      ? opts.radiusKm
      : NEARBY_MAP_DEFAULT_RADIUS_KM;
  const max = opts.max ?? NEARBY_MAP_MAX;
  return riders
    .filter(
      (r) =>
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lng) &&
        Number.isFinite(r.km) &&
        r.km <= radius &&
        isFreshLocation(r.updatedAt, opts.now)
    )
    .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, max));
}

/** UTC day the token salt rotates on ("2026-10-09"). */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * HMAC-SHA256(secret, "<utc day>|<rider id>"). The first bytes become the
 * public token, later (never sent) bytes drive the position offset.
 */
export function riderMapDigest(riderId: string, secret: string, now: number) {
  return createHmac("sha256", secret || DEV_RIDER_MAP_SALT)
    .update(`${utcDay(now)}|${riderId}`)
    .digest();
}

/** The marker id: opaque, the same all (UTC) day for a rider, new the next day. */
export const riderMapToken = (riderId: string, secret: string, now: number) =>
  riderMapDigest(riderId, secret, now).toString("hex").slice(0, TOKEN_HEX);

const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * Rounded to 3 decimals (~100 m), then moved 15–45 m in a direction both taken
 * from `digest` bytes 8–11 (not part of the token): stable per rider and day,
 * different between riders at the same spot.
 */
export function blurPosition(lat: number, lng: number, digest: Buffer) {
  const angle = (digest.readUInt16BE(8) / 0x10000) * 2 * Math.PI;
  const meters = OFFSET_MIN_M + (digest.readUInt16BE(10) / 0xffff) * (OFFSET_MAX_M - OFFSET_MIN_M);
  const baseLat = round(lat, 3);
  const baseLng = round(lng, 3);
  const cosLat = Math.max(Math.cos((baseLat * Math.PI) / 180), 0.01);
  return {
    lat: round(baseLat + (meters * Math.cos(angle)) / METERS_PER_DEG_LAT, 5),
    lng: round(baseLng + (meters * Math.sin(angle)) / (METERS_PER_DEG_LAT * cosLat), 5),
  };
}

const mapVehicle = (v: string | null | undefined): MapVehicle | null =>
  v === "bicycle" || v === "motorcycle" ? v : null;

/** One rider as a map marker (no id, name or exact position). */
export function toMarker(r: MapCandidate, secret: string, now: number): NearbyRiderMarker {
  const digest = riderMapDigest(r.id, secret, now);
  return {
    id: digest.toString("hex").slice(0, TOKEN_HEX),
    ...blurPosition(r.lat, r.lng, digest),
    vehicle_type: mapVehicle(r.vehicle),
    heading: null,
  };
}

/** selectMapRiders → toMarker: what a quote returns as nearby_riders_map. */
export function nearbyRidersMap(
  riders: readonly MapCandidate[],
  opts: { now: number; secret: string; radiusKm?: number | null; max?: number }
): NearbyRiderMarker[] {
  return selectMapRiders(riders, opts).map((r) => toMarker(r, opts.secret, opts.now));
}
