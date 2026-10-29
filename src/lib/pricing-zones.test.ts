import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { courierFare, haversineKm, quoteRoute, routeKm } from "./courier-pricing";
import { geometryAreaKm2, MAX_ZONE_VERTICES, normalizeGeometry, toRuntimeZone, zoneAt, type Position, type ZoneGeometry } from "./geo/zones";
import { PRICING_FIELDS, type PricingKey, PRICING_SCHEMAS, PRICING_SCOPES, PRICING_SEEDS, scopeError } from "./pricing/catalog";
import { fareBreakdown, legFare, roundTo, surchargeFor, type FareFormula } from "./pricing/fare";
import { placeOf, unzonedTier, type PlaceData } from "./pricing/place";
import { overlaps, resolveFrom, type OverrideLike, type PricingContext } from "./pricing/resolve";
import { simulate, type SimPrices } from "./pricing/simulate";
import { quoteRide, rideDuration, rideFare, rideRouteError } from "./ride-pricing";

const square = (w: number, s: number, e: number, n: number): Position[] => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const poly = (ring: Position[], ...holes: Position[][]): ZoneGeometry => ({ type: "Polygon", coordinates: [ring, ...holes] });
const zone = (id: string, geometry: ZoneGeometry, tier = "urban", priority = 0, wilaya_code: string | null = "16") =>
  toRuntimeZone({ id, name: id, tier, wilaya_code, priority, geometry });

describe("zoneAt", () => {
  const big = zone("big", poly(square(3.0, 36.7, 3.2, 36.9)), "town");
  const ALGIERS = { lat: 36.77, lng: 3.06 };

  it("finds the zone containing the point, null outside", () => {
    assert.equal(zoneAt(ALGIERS.lat, ALGIERS.lng, [big])?.id, "big");
    assert.equal(zoneAt(36.0, 3.06, [big]), null);
    assert.equal(zoneAt(NaN, 3.06, [big]), null);
  });

  it("a hole is outside the zone", () => {
    const donut = zone("donut", poly(square(3.0, 36.7, 3.2, 36.9), square(3.08, 36.78, 3.12, 36.82).reverse()));
    assert.equal(zoneAt(36.72, 3.02, [donut])?.id, "donut");
    assert.equal(zoneAt(36.8, 3.1, [donut]), null);
  });

  it("handles a MultiPolygon", () => {
    const multi = zone("multi", {
      type: "MultiPolygon",
      coordinates: [[square(3.0, 36.7, 3.1, 36.8)], [square(4.0, 36.7, 4.1, 36.8)]],
    });
    assert.equal(zoneAt(36.75, 3.05, [multi])?.id, "multi");
    assert.equal(zoneAt(36.75, 4.05, [multi])?.id, "multi");
    assert.equal(zoneAt(36.75, 3.5, [multi]), null);
  });

  it("overlapping zones: higher priority wins, then the smaller area", () => {
    const small = zone("small", poly(square(3.05, 36.75, 3.07, 36.79)), "urban");
    assert.equal(zoneAt(ALGIERS.lat, ALGIERS.lng, [big, small])?.id, "small", "smaller area wins at equal priority");
    assert.equal(zoneAt(ALGIERS.lat, ALGIERS.lng, [small, big])?.id, "small", "order-independent");
    const bigFirst = zone("big2", poly(square(3.0, 36.7, 3.2, 36.9)), "town", 5);
    assert.equal(zoneAt(ALGIERS.lat, ALGIERS.lng, [small, bigFirst])?.id, "big2", "priority beats area");
  });
});

describe("geometry validation", () => {
  it("auto-closes an open ring", () => {
    const open = { type: "Polygon", coordinates: [[[3.0, 36.7], [3.1, 36.7], [3.1, 36.8], [3.0, 36.8]]] };
    const r = normalizeGeometry(open);
    assert.ok(r.ok);
    if (r.ok) {
      const ring = (r.geometry.coordinates as Position[][])[0];
      assert.equal(ring.length, 5);
      assert.deepEqual(ring[0], ring[4]);
    }
  });

  it("rejects too few points, non-polygons and zero area", () => {
    assert.equal(normalizeGeometry({ type: "Polygon", coordinates: [[[3.0, 36.7], [3.1, 36.7]]] }).ok, false);
    assert.equal(normalizeGeometry({ type: "Point", coordinates: [3, 36] }).ok, false);
    assert.equal(normalizeGeometry(null).ok, false);
    assert.equal(normalizeGeometry({ type: "Polygon", coordinates: [[[3.0, 36.7], [3.1, 36.7], [3.2, 36.7], [3.0, 36.7]]] }).ok, false);
  });

  it("rejects points outside Algeria's bbox", () => {
    const r = normalizeGeometry(poly(square(2.3, 48.8, 2.4, 48.9))); // Paris
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /outside Algeria/);
  });

  it("caps the vertex count", () => {
    const ring: Position[] = [];
    for (let i = 0; i < MAX_ZONE_VERTICES + 10; i++) ring.push([3.0 + (i % 100) * 0.0001, 36.7 + Math.floor(i / 100) * 0.0001]);
    const r = normalizeGeometry({ type: "Polygon", coordinates: [ring] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /Too many points/);
  });

  it("computes a plausible area (0.1° × 0.1° near Algiers ≈ 99 km²)", () => {
    const km2 = geometryAreaKm2(poly(square(3.0, 36.7, 3.1, 36.8)));
    assert.ok(km2 > 95 && km2 < 103, `got ${km2}`);
  });
});

describe("override scoring with zone + tier", () => {
  const base: OverrideLike = {
    id: "",
    key: "service_fee",
    service: null,
    wilaya_code: null,
    merchant_id: null,
    agent_id: null,
    zone_id: null,
    tier: null,
    value: null,
    starts_at: null,
    ends_at: null,
  };
  const ov = (id: string, over: Partial<OverrideLike>): OverrideLike => ({ ...base, id, value: { id }, ...over });
  const defaults = { service_fee: { id: "default" } };
  const ctx: PricingContext = { service: "merchant", wilaya: "16", zoneId: "z1", tier: "urban", merchantId: "m1" };
  const pick = (os: OverrideLike[], c = ctx) => resolveFrom(defaults, os, "service_fee", c).overrideId;

  it("zone > tier > wilaya > service", () => {
    const service = ov("service", { service: "merchant" });
    const wilaya = ov("wilaya", { wilaya_code: "16" });
    const tier = ov("tier", { tier: "urban" });
    const zoneO = ov("zone", { zone_id: "z1" });
    assert.equal(pick([service, wilaya, tier, zoneO]), "zone");
    assert.equal(pick([service, wilaya, tier]), "tier");
    assert.equal(pick([service, wilaya]), "wilaya");
    assert.equal(pick([service]), "service");
    // tier + wilaya (6) beats wilaya (2) and tier (4), and service alone
    assert.equal(pick([wilaya, tier, ov("both", { tier: "urban", wilaya_code: "16" })]), "both");
  });

  it("a partner still beats every place scope", () => {
    const partner = ov("partner", { merchant_id: "m1" });
    const zoneService = ov("zone+service", { zone_id: "z1", service: "merchant" });
    assert.equal(pick([zoneService, partner]), "partner");
  });

  it("non-matching zone / tier scopes are ignored (unzoned point, other tier)", () => {
    assert.equal(pick([ov("z", { zone_id: "z1" })], { ...ctx, zoneId: null }), null);
    assert.equal(pick([ov("t", { tier: "urban" })], { ...ctx, tier: "rural" }), null);
    assert.equal(pick([ov("t", { tier: "urban" })], { ...ctx, tier: null }), null);
  });

  it("legacy partner / wilaya / service order is unchanged", () => {
    const p = ov("p", { merchant_id: "m1" });
    const w = ov("w", { wilaya_code: "16" });
    const s = ov("s", { service: "merchant" });
    assert.equal(pick([s, w, p]), "p");
    assert.equal(pick([s, w]), "w");
    assert.equal(pick([s, ov("ws", { wilaya_code: "16", service: "merchant" }), w]), "ws");
    // rows read before zone pricing have no zone_id / tier at all
    const legacy = { ...w } as Partial<OverrideLike>;
    delete legacy.zone_id;
    delete legacy.tier;
    assert.equal(pick([legacy as OverrideLike]), "w");
  });

  it("the overlap guard distinguishes zone and tier scopes", () => {
    const a = ov("a", { key: "service_fee", tier: "urban" });
    assert.equal(overlaps(a, ov("b", { tier: "urban" })), true);
    assert.equal(overlaps(a, ov("b", { tier: "rural" })), false);
    assert.equal(overlaps(a, ov("b", { zone_id: "z1" })), false);
    assert.equal(overlaps(ov("c", { zone_id: "z1" }), ov("d", { zone_id: "z1" })), true);
  });
});

describe("scope rules", () => {
  it("zone / tier scopes only on the keys that allow them", () => {
    assert.equal(scopeError("courier_fare", { zone_id: "z" }), null);
    assert.equal(scopeError("courier_fare", { tier: "rural", wilaya_code: "6" }), null);
    assert.ok(scopeError("blink_cash_fee_rate", { zone_id: "z" }));
    assert.ok(scopeError("stamp_duty_rate", { tier: "urban" }));
    assert.ok(scopeError("zone_defaults", { tier: "urban" }));
    assert.equal(scopeError("zone_defaults", { wilaya_code: "16" }), null);
  });

  it("a zone can't also carry a wilaya or a tier", () => {
    assert.match(scopeError("ride_fare", { zone_id: "z", wilaya_code: "16" }) ?? "", /wilaya/);
    assert.match(scopeError("ride_fare", { zone_id: "z", tier: "urban" }) ?? "", /tier/);
  });

  it("the spec's tier-scopable keys are switched on", () => {
    for (const k of [
      "service_fee", "courier_fare", "ride_fare", "fare_multiplier", "fare_formula",
      "dropoff_surcharge", "service_area", "rider_commission_rate", "merchant_commission_rate",
    ] as const satisfies readonly PricingKey[]) {
      assert.ok(PRICING_SCOPES[k].zone && PRICING_SCOPES[k].tier, k);
    }
    // merchant / shopper added by store_delivery (distance mode uses the formula).
    assert.deepEqual(PRICING_SCOPES.fare_formula.service, ["courier", "ride", "merchant", "shopper"]);
    assert.equal(PRICING_SCOPES.zone_defaults.zone, false);
  });
});

describe("stored values without the new fields still parse", () => {
  it("a legacy courier_fare / ride_fare (no per_minute) keeps its staff prices", () => {
    const courier = {
      bicycle: { base: 150, included_km: 2, per_km: 36, max_km: 10 },
      motorcycle: { base: 260, included_km: 3, per_km: 41, max_km: 40 },
      extra_stop_fee: 70,
    };
    const c = PRICING_SCHEMAS.courier_fare.safeParse(courier);
    assert.ok(c.success);
    if (c.success) {
      assert.equal(c.data.bicycle.per_minute, 0);
      assert.equal(c.data.bicycle.base, 150);
      assert.equal(c.data.extra_stop_fee, 70);
    }
    const r = PRICING_SCHEMAS.ride_fare.safeParse({ motorcycle: { base: 210, included_km: 3, per_km: 40, max_km: 40 } });
    assert.ok(r.success);
    if (r.success) assert.equal(r.data.motorcycle.per_minute, 0);
  });

  it("new keys default missing fields; bounds still apply", () => {
    const f = PRICING_SCHEMAS.fare_formula.safeParse({ road_factor: 1.5 });
    assert.ok(f.success);
    if (f.success) assert.deepEqual({ ...f.data, road_factor: 1.3 }, PRICING_SEEDS.fare_formula);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ road_factor: 3.01 }).success, false);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ rounding_mode: "sideways" }).success, false);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ rounding_step: 0 }).success, false);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ speed_kmh: { bicycle: 4 } }).success, false);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ min_fare: 500, max_fare: 300 }).success, false);
    assert.equal(PRICING_SCHEMAS.fare_formula.safeParse({ min_fare: 500, max_fare: 0 }).success, true);
    assert.equal(PRICING_SCHEMAS.dropoff_surcharge.safeParse({ amount: 5001 }).success, false);
    assert.equal(PRICING_SCHEMAS.zone_defaults.safeParse({ unzoned_tier: "Rural!" }).success, false);
  });

  it("field metadata for the new units", () => {
    const f = Object.fromEntries(PRICING_FIELDS.fare_formula.map((x) => [x.path, x]));
    assert.equal(f.rounding_mode.unit, "choice");
    assert.deepEqual(f.rounding_mode.options, ["up", "nearest", "down"]);
    assert.equal(f["speed_kmh.bicycle"].unit, "kmh");
    assert.equal(f.stop_minutes.unit, "min");
    assert.equal(PRICING_FIELDS.dropoff_surcharge[1].unit, "bool");
    assert.equal(PRICING_FIELDS.zone_defaults[0].unit, "tier");
    assert.ok(PRICING_FIELDS.courier_fare.some((x) => x.path === "bicycle.per_minute"));
  });
});

describe("the 6-step fare formula", () => {
  // Today's fare before zone pricing: base + metres beyond included + extra stops, × multiplier, ceil to 10.
  const oldFare = (leg: { base: number; included_km: number; per_km: number }, km: number, stops: number, extra: number, mult: number) => {
    const raw = leg.base + Math.max(0, km - leg.included_km) * leg.per_km + Math.max(0, stops - 1) * extra;
    return Math.ceil(Math.round(raw * mult * 1e6) / 1e6 / 10) * 10;
  };

  it("the seed formula reproduces the old fares on a table of km / stops / vehicles", () => {
    const courier = PRICING_SEEDS.courier_fare;
    const ride = PRICING_SEEDS.ride_fare;
    for (const km of [0, 0.4, 1, 2, 2.1, 3, 3.3, 5, 5.6, 7.7, 10, 12.3, 25.9, 40]) {
      for (const mult of [1, 1.1, 0.9, 1.5, 2, 0.5]) {
        for (const stops of [1, 2, 5]) {
          for (const v of ["bicycle", "motorcycle"] as const) {
            assert.equal(courierFare(v, km, stops, courier, mult), oldFare(courier[v], km, stops, courier.extra_stop_fee, mult), `courier ${v} ${km}km ${stops} stops ×${mult}`);
          }
        }
        assert.equal(rideFare("motorcycle", km, ride, mult), oldFare(ride.motorcycle, km, 1, 0, mult), `ride ${km}km ×${mult}`);
      }
    }
  });

  it("the seed formula keeps today's road factor, durations and min ride distance", () => {
    const f = PRICING_SEEDS.fare_formula;
    assert.deepEqual(
      { r: f.road_factor, s: f.rounding_step, m: f.rounding_mode, mf: f.min_fare, xf: f.max_fare, mk: f.min_ride_km, sp: f.speed_kmh, st: f.stop_minutes, b: f.boarding_minutes },
      { r: 1.3, s: 10, m: "up", mf: 0, xf: 0, mk: 0.3, sp: { bicycle: 14, motorcycle: 28 }, st: 3, b: 2 }
    );
    assert.equal(rideDuration("motorcycle", 14), 32);
    const a = { lat: 36.7731, lng: 3.0596 };
    const b = { lat: 36.7445, lng: 3.0283 };
    assert.equal(routeKm(a, [b]), Math.round(haversineKm(a, b) * 1.3 * 10) / 10);
  });

  it("rounding modes: up / nearest / down", () => {
    assert.equal(roundTo(304, 10, "up"), 310);
    assert.equal(roundTo(304, 10, "nearest"), 300);
    assert.equal(roundTo(305, 10, "nearest"), 310);
    assert.equal(roundTo(309, 10, "down"), 300);
    assert.equal(roundTo(300, 10, "up"), 300);
    assert.equal(roundTo(220.00000000000003, 10, "up"), 220);
    assert.equal(roundTo(7, 5, "up"), 10);
    assert.equal(roundTo(7, 1, "nearest"), 7);
  });

  const leg = { base: 200, included_km: 3, per_km: 40, max_km: 40 };
  const withFormula = (over: Partial<FareFormula>): FareFormula => ({ ...PRICING_SEEDS.fare_formula, ...over });

  it("min_fare lifts and max_fare caps (max 0 = off), before rounding", () => {
    assert.equal(legFare(leg, 0, { formula: withFormula({ min_fare: 300 }) }), 300);
    assert.equal(legFare(leg, 10, { formula: withFormula({ max_fare: 400 }) }), 400); // raw 480
    assert.equal(legFare(leg, 10, { formula: withFormula({ max_fare: 0 }) }), 480);
    assert.equal(legFare(leg, 10, { formula: withFormula({ max_fare: 455 }) }), 460); // clamp 455 → round up
    assert.equal(legFare(leg, 10, { formula: withFormula({ rounding_step: 50, rounding_mode: "nearest" }) }), 500);
  });

  it("per_minute adds drive time (km / speed × 60) × rate", () => {
    const timed = { ...leg, per_minute: 2 };
    // 14 km at 28 km/h = 30 min × 2 = 60; 200 + 11 × 40 = 640 + 60
    assert.equal(legFare(timed, 14, { speedKmh: 28 }), 700);
    assert.equal(legFare(timed, 14), 640, "no speed → no time component");
    assert.equal(legFare(leg, 14, { speedKmh: 28 }), 640, "per_minute 0 changes nothing");
    assert.equal(rideFare("motorcycle", 14, { motorcycle: timed }), 700);
  });

  it("the multiplier scales everything including the surcharge, then clamp, then rounding", () => {
    // (200 + 0 + 50 surcharge) × 1.1 = 275 → 280
    assert.equal(legFare(leg, 2, { surcharge: 50, multiplier: 1.1 }), 280);
  });

  it("drop-off surcharge: only_when_tier_changes", () => {
    const rule = { amount: 50, only_when_tier_changes: true };
    assert.equal(surchargeFor(rule, "urban", "rural"), 50);
    assert.equal(surchargeFor(rule, "rural", "rural"), 0, "village → same-tier village pays nothing");
    assert.equal(surchargeFor(rule, "urban", null), 50, "an archived/missing drop-off tier counts as a change");
    assert.equal(surchargeFor({ amount: 50, only_when_tier_changes: false }, "rural", "rural"), 50);
    assert.equal(surchargeFor({ amount: 0, only_when_tier_changes: false }, "urban", "rural"), 0);
    assert.equal(courierFare("motorcycle", 1, 1, PRICING_SEEDS.courier_fare, 1, { surcharge: 50 }), 300);
  });

  it("breakdown steps sum to the fare", () => {
    const formula = withFormula({ min_fare: 0, max_fare: 455, rounding_step: 10 });
    const cases = [
      { km: 10, opts: { multiplier: 1.1, surcharge: 30, speedKmh: 28, stops: 3, extraStopFee: 60, formula } },
      { km: 0, opts: { formula: withFormula({ min_fare: 300 }) } },
      { km: 14, opts: { speedKmh: 28 } },
    ];
    for (const c of cases) {
      const b = fareBreakdown({ ...leg, per_minute: 1.5 }, c.km, c.opts);
      const sum = b.steps.reduce((n, s) => n + s.amount, 0);
      assert.ok(Math.abs(sum - b.fare) < 1e-6, `${c.km}km: ${sum} vs ${b.fare}`);
      assert.deepEqual(b.steps.map((s) => s.step), ["base", "distance", "time", "extra_stops", "dropoff_surcharge", "multiplier", "clamp", "rounding"]);
    }
  });
});

describe("formula-driven durations, distances and ride limits", () => {
  const a = { lat: 36.7731, lng: 3.0596 };
  const b = { lat: 36.7445, lng: 3.0283 };
  const formula = { ...PRICING_SEEDS.fare_formula, road_factor: 2, min_ride_km: 10, speed_kmh: { bicycle: 10, motorcycle: 20 }, boarding_minutes: 5 };

  it("road factor, speed and boarding time come from the formula", () => {
    assert.ok(routeKm(a, [b], formula) > routeKm(a, [b]));
    assert.equal(rideDuration("motorcycle", 10, formula), 35);
  });

  it("min_ride_km makes a short trip too_close", () => {
    assert.equal(rideRouteError(a, b, PRICING_SEEDS.ride_fare, "motorcycle", formula), "too_close");
    assert.equal(rideRouteError(a, b, PRICING_SEEDS.ride_fare), null);
  });

  it("service_area off → every option unavailable: out_of_service_area", () => {
    const ride = quoteRide(a, b, PRICING_SEEDS.ride_fare, 1, { enabled: false });
    assert.equal(ride.options[0].available, false);
    assert.equal(ride.options[0].unavailable_reason, "out_of_service_area");
    const courier = quoteRoute(a, [b], PRICING_SEEDS.courier_fare, 1, { enabled: false });
    assert.ok(courier.options.every((o) => !o.available && o.unavailable_reason === "out_of_service_area"));
    const ok = quoteRoute(a, [b], PRICING_SEEDS.courier_fare);
    assert.ok(ok.options.every((o) => o.available && o.unavailable_reason === null));
  });
});

describe("unzoned tier resolution + place", () => {
  const defaults = { zone_defaults: { unzoned_tier: "rural" } };
  const ov = (id: string, wilaya: string, tier: string): OverrideLike => ({
    id,
    key: "zone_defaults",
    service: null,
    wilaya_code: wilaya,
    merchant_id: null,
    agent_id: null,
    value: { unzoned_tier: tier },
    starts_at: null,
    ends_at: null,
  });
  const data = (over: Partial<PlaceData> = {}): PlaceData => ({
    zones: [],
    tiers: ["urban", "town", "rural"],
    defaults,
    overrides: [],
    ...over,
  });

  it("defaults to the zone_defaults tier", () => {
    assert.deepEqual(unzonedTier(data(), "16"), { tier: "rural", overrideId: null });
  });

  it("a wilaya override changes the unzoned tier for that wilaya only", () => {
    const d = data({ overrides: [ov("o1", "16", "town")] });
    assert.deepEqual(unzonedTier(d, "16"), { tier: "town", overrideId: "o1" });
    assert.equal(unzonedTier(d, "31").tier, "rural");
    assert.equal(unzonedTier(d, null).tier, "rural");
  });

  it("an archived / missing tier resolves to null", () => {
    assert.equal(unzonedTier(data({ tiers: ["urban", "town"] }), "16").tier, null);
    assert.equal(unzonedTier(data({ overrides: [ov("o1", "16", "ghost")] }), "16").tier, null);
  });

  it("a point inside a zone takes the zone's tier, outside takes the unzoned tier", () => {
    const z = zone("alger-centre", poly(square(3.0, 36.7, 3.1, 36.8)), "urban");
    const d = data({ zones: [z] });
    const inside = placeOf({ lat: 36.75, lng: 3.05 }, d);
    assert.deepEqual(
      { wilaya: inside.wilaya, zoneId: inside.zoneId, tier: inside.tier, unzoned: inside.unzoned },
      { wilaya: "16", zoneId: "alger-centre", tier: "urban", unzoned: false }
    );
    const outside = placeOf({ lat: 36.5, lng: 3.05 }, d);
    assert.equal(outside.zoneId, null);
    assert.equal(outside.tier, "rural");
    assert.equal(outside.unzoned, true);
  });

  it("a wilaya hint overrides the polygon lookup", () => {
    const p = placeOf({ lat: 36.5, lng: 3.05 }, data({ overrides: [ov("o1", "31", "town")] }), { wilaya: "31" });
    assert.equal(p.wilaya, "31");
    assert.equal(p.tier, "town");
  });
});

describe("simulate: breakdown", () => {
  const prices: SimPrices = {
    courier_fare: PRICING_SEEDS.courier_fare,
    ride_fare: PRICING_SEEDS.ride_fare,
    fare_multiplier: { multiplier: 1.1 },
    fare_formula: { ...PRICING_SEEDS.fare_formula, max_fare: 0 },
    rider_commission_rate: PRICING_SEEDS.rider_commission_rate,
  };
  const total = (r: ReturnType<typeof simulate>) => (r.breakdown ?? []).reduce((n, s) => n + s.amount, 0);

  it("the steps sum to the fare for courier and ride", () => {
    const c = simulate("courier", { km: 6.3, vehicle: "motorcycle", stops: 3, surcharge: 40 }, prices);
    assert.ok(c.breakdown && c.breakdown.length === 8);
    assert.ok(Math.abs(total(c) - c.payer_total) < 1e-6);
    assert.equal(c.breakdown!.find((s) => s.step === "dropoff_surcharge")!.amount, 40);
    const r = simulate("ride", { km: 9 }, prices);
    assert.ok(Math.abs(total(r) - r.payer_total) < 1e-6);
  });

  it("unavailable reasons: out_of_service_area, too_close, too_far", () => {
    assert.equal(simulate("courier", { km: 5, in_service_area: false }, prices).unavailable, "out_of_service_area");
    assert.equal(simulate("ride", { km: 5, straight_km: 0.1 }, prices).unavailable, "too_close");
    assert.equal(simulate("ride", { km: 41 }, prices).unavailable, "too_far");
    assert.equal(simulate("courier", { km: 11, vehicle: "bicycle" }, prices).unavailable, "too_far");
  });
});
