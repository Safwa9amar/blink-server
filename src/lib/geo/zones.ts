// Pricing zones: GeoJSON polygons drawn by staff, each carrying a tier.
// Pure geometry only — no DB (the cached loader lives in lib/pricing).
//  - normalizeGeometry: validate + auto-close what the dashboard sends;
//  - toRuntimeZone: precompute bbox + area so zoneAt stays a cheap scan;
//  - zoneAt: which zone contains a point (priority, then smaller area wins).
// Coordinates are GeoJSON order: [lng, lat].
import { wilayaAt } from "./wilaya";

export type Position = [number, number];
export type ZoneGeometry =
  | { type: "Polygon"; coordinates: Position[][] }
  | { type: "MultiPolygon"; coordinates: Position[][][] };

/** Algeria's bounding box — a drawn vertex outside it is a typo, not a village. */
export const ALGERIA_BBOX = { minLat: 18.9, maxLat: 37.2, minLng: -8.7, maxLng: 12.0 } as const;
export const MAX_ZONE_VERTICES = 5_000;

export type GeometryResult = { ok: true; geometry: ZoneGeometry } | { ok: false; error: string };

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function ringOf(raw: unknown, label: string): { ring: Position[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: `${label} must be an array of [lng, lat] points` };
  const ring: Position[] = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) {
      return { error: `${label} has a point that isn't [lng, lat]` };
    }
    const [lng, lat] = p as number[];
    if (lat < ALGERIA_BBOX.minLat || lat > ALGERIA_BBOX.maxLat || lng < ALGERIA_BBOX.minLng || lng > ALGERIA_BBOX.maxLng) {
      return { error: `${label} has a point outside Algeria (${lat}, ${lng})` };
    }
    ring.push([lng, lat]);
  }
  // Auto-close: GeoJSON wants first == last, drawing tools often leave it open.
  if (ring.length >= 1) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  }
  if (ring.length < 4) return { error: `${label} needs at least 3 distinct points` };
  return { ring };
}

/** Validate a Polygon / MultiPolygon and return it with every ring closed. */
export function normalizeGeometry(input: unknown): GeometryResult {
  const g = input as { type?: unknown; coordinates?: unknown } | null;
  if (!g || typeof g !== "object") return { ok: false, error: "Geometry must be a GeoJSON Polygon or MultiPolygon" };

  let polygons: unknown[];
  if (g.type === "Polygon") polygons = [g.coordinates];
  else if (g.type === "MultiPolygon" && Array.isArray(g.coordinates)) polygons = g.coordinates;
  else return { ok: false, error: "Geometry must be a GeoJSON Polygon or MultiPolygon" };
  if (!polygons.length) return { ok: false, error: "Geometry has no polygon" };

  const out: Position[][][] = [];
  let vertices = 0;
  for (const [pi, poly] of polygons.entries()) {
    if (!Array.isArray(poly) || !poly.length) return { ok: false, error: `Polygon ${pi + 1} has no ring` };
    const rings: Position[][] = [];
    for (const [ri, raw] of poly.entries()) {
      const r = ringOf(raw, ri === 0 ? `Polygon ${pi + 1}` : `Polygon ${pi + 1} hole ${ri}`);
      if ("error" in r) return { ok: false, error: r.error };
      vertices += r.ring.length;
      if (vertices > MAX_ZONE_VERTICES) return { ok: false, error: `Too many points (max ${MAX_ZONE_VERTICES})` };
      rings.push(r.ring);
    }
    out.push(rings);
  }
  const geometry: ZoneGeometry = g.type === "Polygon" ? { type: "Polygon", coordinates: out[0] } : { type: "MultiPolygon", coordinates: out };
  if (geometryAreaKm2(geometry) <= 0) return { ok: false, error: "The zone has no area" };
  return { ok: true, geometry };
}

const polygonsOf = (g: ZoneGeometry): Position[][][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

export type BBox = { minLng: number; maxLng: number; minLat: number; maxLat: number };

export function geometryBBox(g: ZoneGeometry): BBox {
  const b: BBox = { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity };
  for (const poly of polygonsOf(g)) {
    for (const [lng, lat] of poly[0]) {
      if (lng < b.minLng) b.minLng = lng;
      if (lng > b.maxLng) b.maxLng = lng;
      if (lat < b.minLat) b.minLat = lat;
      if (lat > b.maxLat) b.maxLat = lat;
    }
  }
  return b;
}

/** Shoelace area of one ring in km², on a local equirectangular plane (fine at city scale). */
function ringAreaKm2(ring: Position[]): number {
  const lat0 = ring.reduce((n, p) => n + p[1], 0) / ring.length;
  const kx = 111.320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110.574;
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
    s += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
  }
  return Math.abs(s) / 2;
}

/** Area in km² (holes subtracted). */
export function geometryAreaKm2(g: ZoneGeometry): number {
  let area = 0;
  for (const poly of polygonsOf(g)) {
    poly.forEach((ring, i) => {
      area += (i === 0 ? 1 : -1) * ringAreaKm2(ring);
    });
  }
  return Math.max(0, area);
}

function inRing(ring: Position[], lng: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in geometry: inside an outer ring and outside every hole of that polygon. */
export function pointInGeometry(g: ZoneGeometry, lat: number, lng: number): boolean {
  for (const poly of polygonsOf(g)) {
    if (!inRing(poly[0], lng, lat)) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (inRing(poly[i], lng, lat)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

/** A zone as the pricing snapshot keeps it. */
export type RuntimeZone = {
  id: string;
  name: string;
  tier: string;
  wilaya_code: string | null;
  priority: number;
  geometry: ZoneGeometry;
  bbox: BBox;
  area_km2: number;
};

export function toRuntimeZone(z: {
  id: string;
  name: string;
  tier: string;
  wilaya_code: string | null;
  priority: number | null;
  geometry: ZoneGeometry;
}): RuntimeZone {
  return { ...z, priority: z.priority ?? 0, bbox: geometryBBox(z.geometry), area_km2: geometryAreaKm2(z.geometry) };
}

/**
 * The zone containing the point. Overlapping zones: highest `priority` wins,
 * then the smaller area (the village inside a bigger town), then id for a
 * stable answer. Null = unzoned.
 */
export function zoneAt(lat: number, lng: number, zones: RuntimeZone[]): RuntimeZone | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best: RuntimeZone | null = null;
  for (const z of zones) {
    const b = z.bbox;
    if (lng < b.minLng || lng > b.maxLng || lat < b.minLat || lat > b.maxLat) continue;
    if (!pointInGeometry(z.geometry, lat, lng)) continue;
    if (
      !best ||
      z.priority > best.priority ||
      (z.priority === best.priority && (z.area_km2 < best.area_km2 || (z.area_km2 === best.area_km2 && z.id < best.id)))
    ) {
      best = z;
    }
  }
  return best;
}

/** The wilaya a drawn geometry sits in (the average of its first outer ring), or null. */
export function geometryWilaya(g: ZoneGeometry): string | null {
  const ring = polygonsOf(g)[0][0];
  const pts = ring.slice(0, -1);
  const lng = pts.reduce((n, p) => n + p[0], 0) / pts.length;
  const lat = pts.reduce((n, p) => n + p[1], 0) / pts.length;
  return wilayaAt(lat, lng);
}
