import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blurPosition,
  DEV_RIDER_MAP_SALT,
  isFreshLocation,
  NEARBY_MAP_MAX,
  nearbyRidersMap,
  riderMapDigest,
  riderMapToken,
  selectMapRiders,
  type MapCandidate,
} from "./nearby-riders-map";

const NOW = Date.parse("2026-10-09T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const SECRET = "test-secret";

const rider = (over: Partial<MapCandidate> = {}): MapCandidate => ({
  id: "11111111-1111-1111-1111-111111111111",
  lat: 36.75312,
  lng: 3.05876,
  km: 1,
  vehicle: "motorcycle",
  updatedAt: ago(1),
  ...over,
});

/** Metres between two points (equirectangular; fine at these distances). */
const meters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
  const dLat = (a.lat - b.lat) * 111_320;
  const dLng = (a.lng - b.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

describe("isFreshLocation", () => {
  it("within 10 minutes only", () => {
    assert.equal(isFreshLocation(ago(0), NOW), true);
    assert.equal(isFreshLocation(ago(9.9), NOW), true);
    assert.equal(isFreshLocation(ago(10), NOW), true);
    assert.equal(isFreshLocation(ago(10.1), NOW), false);
    assert.equal(isFreshLocation(ago(120), NOW), false);
  });

  it("no / bad timestamp → stale; slight clock skew ahead tolerated, far future not", () => {
    assert.equal(isFreshLocation(null, NOW), false);
    assert.equal(isFreshLocation(undefined, NOW), false);
    assert.equal(isFreshLocation("not a date", NOW), false);
    assert.equal(isFreshLocation(ago(-0.5), NOW), true);
    assert.equal(isFreshLocation(ago(-60), NOW), false);
  });
});

describe("selectMapRiders", () => {
  it("drops stale, unlocated and out-of-radius riders; nearest first", () => {
    const riders = [
      rider({ id: "far", km: 14 }),
      rider({ id: "out", km: 15.5 }),
      rider({ id: "stale", km: 0.2, updatedAt: ago(30) }),
      rider({ id: "never", km: 0.3, updatedAt: null }),
      rider({ id: "near", km: 0.5 }),
      rider({ id: "mid", km: 3 }),
      rider({ id: "nan", km: 1, lat: Number.NaN }),
    ];
    const picked = selectMapRiders(riders, { now: NOW, radiusKm: 15 });
    assert.deepEqual(
      picked.map((r) => r.id),
      ["near", "mid", "far"]
    );
  });

  it("5 km when unbounded", () => {
    const riders = [rider({ id: "a", km: 4.9 }), rider({ id: "b", km: 5.1 })];
    for (const radiusKm of [undefined, null, Infinity, 0]) {
      assert.deepEqual(
        selectMapRiders(riders, { now: NOW, radiusKm }).map((r) => r.id),
        ["a"]
      );
    }
  });

  it("at most 12, ties broken by id, input untouched", () => {
    const riders = Array.from({ length: 20 }, (_, i) => rider({ id: `r${String(i).padStart(2, "0")}`, km: i % 2 }));
    const before = riders.map((r) => r.id);
    const picked = selectMapRiders(riders, { now: NOW, radiusKm: 15 });
    assert.equal(picked.length, NEARBY_MAP_MAX);
    assert.deepEqual(
      picked.map((r) => r.id),
      ["r00", "r02", "r04", "r06", "r08", "r10", "r12", "r14", "r16", "r18", "r01", "r03"]
    );
    assert.deepEqual(
      riders.map((r) => r.id),
      before
    );
    assert.equal(selectMapRiders(riders, { now: NOW, radiusKm: 15, max: 3 }).length, 3);
  });
});

describe("riderMapToken", () => {
  it("16 hex chars, stable for the day, never the rider id", () => {
    const t = riderMapToken("rider-1", SECRET, NOW);
    assert.match(t, /^[0-9a-f]{16}$/);
    assert.equal(riderMapToken("rider-1", SECRET, NOW + 3 * 3600_000), t);
    assert.ok(!t.includes("rider"));
  });

  it("differs per rider, per day and per secret; empty secret → dev fallback", () => {
    const t = riderMapToken("rider-1", SECRET, NOW);
    assert.notEqual(riderMapToken("rider-2", SECRET, NOW), t);
    assert.notEqual(riderMapToken("rider-1", SECRET, NOW + 24 * 3600_000), t);
    assert.notEqual(riderMapToken("rider-1", "other-secret", NOW), t);
    assert.equal(riderMapToken("rider-1", "", NOW), riderMapToken("rider-1", DEV_RIDER_MAP_SALT, NOW));
  });
});

describe("blurPosition", () => {
  it("about 100 m from the real spot, never on it, at most 5 decimals", () => {
    for (let i = 0; i < 50; i++) {
      const real = { lat: 36.7 + i * 0.00137, lng: 3.0 + i * 0.00211 };
      const blurred = blurPosition(real.lat, real.lng, riderMapDigest(`r${i}`, SECRET, NOW));
      const d = meters(real, blurred);
      // ≤ ~71 m of rounding (3 decimals at 36°N) + ≤ 45 m offset.
      assert.ok(d < 120, `rider ${i} is ${d.toFixed(0)} m away`);
      assert.notDeepEqual(blurred, real);
      assert.equal(blurred.lat, Math.round(blurred.lat * 1e5) / 1e5);
      assert.equal(blurred.lng, Math.round(blurred.lng * 1e5) / 1e5);
    }
  });

  it("offset 15–45 m from the rounded cell; riders parked together don't stack", () => {
    const spot = { lat: 36.75312, lng: 3.05876 };
    const cell = { lat: 36.753, lng: 3.059 };
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const p = blurPosition(spot.lat, spot.lng, riderMapDigest(`rider-${i}`, SECRET, NOW));
      const d = meters(cell, p);
      assert.ok(d >= 14 && d <= 46, `offset ${d.toFixed(1)} m`);
      seen.add(`${p.lat},${p.lng}`);
    }
    assert.equal(seen.size, 20);
  });

  it("deterministic for a rider and day", () => {
    const d = riderMapDigest("rider-1", SECRET, NOW);
    assert.deepEqual(blurPosition(36.75312, 3.05876, d), blurPosition(36.75312, 3.05876, d));
    // Moving within the same ~100 m cell doesn't move the marker.
    assert.deepEqual(blurPosition(36.75312, 3.05876, d), blurPosition(36.75299, 3.05901, d));
  });
});

describe("nearbyRidersMap", () => {
  it("markers: token id, blurred position, vehicle, heading null", () => {
    const riders = [
      rider({ id: "u-moto", km: 0.4, vehicle: "motorcycle" }),
      rider({ id: "u-bike", km: 0.2, vehicle: "bicycle" }),
      rider({ id: "u-none", km: 0.9, vehicle: null }),
      rider({ id: "u-odd", km: 1.2, vehicle: "car" }),
    ];
    const markers = nearbyRidersMap(riders, { now: NOW, secret: SECRET, radiusKm: 15 });
    assert.deepEqual(
      markers.map((m) => [m.id, m.vehicle_type, m.heading]),
      [
        [riderMapToken("u-bike", SECRET, NOW), "bicycle", null],
        [riderMapToken("u-moto", SECRET, NOW), "motorcycle", null],
        [riderMapToken("u-none", SECRET, NOW), null, null],
        [riderMapToken("u-odd", SECRET, NOW), null, null],
      ]
    );
    for (const m of markers) assert.deepEqual(Object.keys(m).sort(), ["heading", "id", "lat", "lng", "vehicle_type"]);
  });

  it("never leaks the rider id or exact position", () => {
    const r = rider({ id: "8f0c2b7e-0000-4000-8000-000000000001" });
    const [m] = nearbyRidersMap([r], { now: NOW, secret: SECRET, radiusKm: 15 });
    const json = JSON.stringify(m);
    assert.ok(!json.includes(r.id));
    assert.ok(!json.includes(String(r.lat)) && !json.includes(String(r.lng)));
    assert.notEqual(m.lat, r.lat);
    assert.notEqual(m.lng, r.lng);
  });

  it("empty in, empty out", () => {
    assert.deepEqual(nearbyRidersMap([], { now: NOW, secret: SECRET }), []);
  });
});
