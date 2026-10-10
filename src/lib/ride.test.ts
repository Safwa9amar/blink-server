import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRideDetails,
  isPassengerNoShow,
  isRideCustomerCancelReason,
  isRideSearchExpired,
  markRideArrived,
  noShowWaitLeftMs,
  rideCanPickUp,
  rideCustomerCancelable,
  rideItems,
  rideLiveAt,
  rideOf,
  rideRiderProblem,
  riderCanTakeRide,
  ridePassenger,
  RIDE_NO_SHOW_WAIT_MS,
  RIDE_SEARCH_TIMEOUT_MS,
  startNoShowClock,
  type RideRequestInput,
} from "./ride";
import { COURIER_SEARCH_TIMEOUT_MS, isCourierSearchExpired } from "./courier";

const input = (over: Partial<RideRequestInput> = {}): RideRequestInput => ({
  pickup: { label: " Grande Poste ", address: "Bd Khemisti, Alger", lat: 36.7731, lng: 3.0596, note: "  " },
  destination: { label: "", address: "Hydra, Alger", lat: 36.7445, lng: 3.0283 },
  ...over,
});
const estimate = { distanceKm: 5.6, durationMinutes: 14 };

describe("buildRideDetails", () => {
  it("trims, nulls empty optionals and starts not arrived", () => {
    const r = buildRideDetails(input(), estimate);
    assert.equal(r.pickup.label, "Grande Poste");
    assert.equal(r.pickup.note, null);
    assert.equal(r.destination.label, "Hydra, Alger");
    assert.equal(r.passenger, null);
    assert.equal(r.distance_km, 5.6);
    assert.equal(r.duration_minutes, 14);
    assert.equal(r.female_rider_only, false);
    assert.equal(r.arrived_at, null);
  });

  it("keeps a passenger only with both a name and a phone", () => {
    const named = buildRideDetails(input({ passenger: { name: " Amina ", phone: "0550 00 00 01" } }), estimate);
    assert.deepEqual(named.passenger, { name: "Amina", phone: "0550 00 00 01" });
    const half = buildRideDetails(input({ passenger: { name: "Amina", phone: " " } }), estimate);
    assert.equal(half.passenger, null);
  });

  it("stores the female-rider wish", () => {
    assert.equal(buildRideDetails(input({ female_rider_only: true }), estimate).female_rider_only, true);
  });
});

describe("rideOf / markRideArrived / rideItems", () => {
  it("reads a ride and ignores anything else", () => {
    const r = buildRideDetails(input(), estimate);
    assert.equal(rideOf({ ride: r }), r);
    assert.equal(rideOf({ ride: null }), null);
    assert.equal(rideOf({ ride: { pickup: {} } }), null);
    assert.equal(rideOf({}), null);
  });

  it("stamps the first arrival only and never mutates", () => {
    const r = buildRideDetails(input(), estimate);
    const once = markRideArrived(r, "t1");
    assert.equal(once.arrived_at, "t1");
    assert.equal(markRideArrived(once, "t2").arrived_at, "t1");
    assert.equal(r.arrived_at, null);
  });

  it("lists one item: the destination", () => {
    assert.deepEqual(rideItems(buildRideDetails(input(), estimate)), [
      { name: "Hydra, Alger", quantity: 1, unit_price: 0 },
    ]);
  });
});

describe("ridePassenger", () => {
  const customer = { name: "Karim B.", phone: "0661 11 22 33" };

  it("falls back to the customer when nobody else rides", () => {
    assert.deepEqual(ridePassenger(buildRideDetails(input(), estimate), customer), {
      name: "Karim B.",
      phone: "0661 11 22 33",
      for_someone_else: false,
    });
    assert.deepEqual(ridePassenger(null, { name: null, phone: null }), {
      name: "Customer",
      phone: null,
      for_someone_else: false,
    });
  });

  it("names the passenger the customer booked for", () => {
    const r = buildRideDetails(input({ passenger: { name: "Amina", phone: "0550000001" } }), estimate);
    assert.deepEqual(ridePassenger(r, customer), { name: "Amina", phone: "0550000001", for_someone_else: true });
  });
});

describe("isRideSearchExpired", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const base = { type: "ride", status: "searching", rider_id: null };
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("expires an unclaimed ride after 10 minutes", () => {
    assert.equal(RIDE_SEARCH_TIMEOUT_MS, 10 * 60 * 1000);
    assert.equal(isRideSearchExpired({ ...base, created_at: ago(RIDE_SEARCH_TIMEOUT_MS + 1000) }, now), true);
    assert.equal(isRideSearchExpired({ ...base, created_at: ago(RIDE_SEARCH_TIMEOUT_MS - 1000) }, now), false);
  });

  it("counts a scheduled ride from its scheduled time", () => {
    const o = { ...base, created_at: ago(3 * 60 * 60 * 1000), scheduled_at: ago(5 * 60 * 1000) };
    assert.equal(rideLiveAt(o), now - 5 * 60 * 1000);
    assert.equal(isRideSearchExpired(o, now), false);
  });

  it("restarts the window when a rider dropped it back into the pool", () => {
    const o = { ...base, created_at: ago(60 * 60 * 1000), accepted_at: ago(60 * 1000) };
    assert.equal(isRideSearchExpired(o, now), false);
  });

  it("never expires a claimed, moved-on or non-ride order", () => {
    const old = ago(RIDE_SEARCH_TIMEOUT_MS * 3);
    assert.equal(isRideSearchExpired({ ...base, created_at: old, rider_id: "r1" }, now), false);
    assert.equal(isRideSearchExpired({ ...base, created_at: old, status: "pickup" }, now), false);
    assert.equal(isRideSearchExpired({ ...base, created_at: old, type: "courier" }, now), false);
  });

  it("keeps the courier window separate (20 minutes)", () => {
    const fifteen = ago(15 * 60 * 1000);
    assert.equal(isRideSearchExpired({ ...base, created_at: fifteen }, now), true);
    assert.equal(isCourierSearchExpired({ ...base, type: "courier", created_at: fifteen }, now), false);
    assert.ok(COURIER_SEARCH_TIMEOUT_MS > RIDE_SEARCH_TIMEOUT_MS);
  });
});

describe("cancel rules", () => {
  it("lets the customer cancel until the passenger is on board", () => {
    for (const s of ["searching", "heading_to_store", "pickup"]) assert.equal(rideCustomerCancelable(s), true);
    for (const s of ["on_the_way", "delivered", "canceled", "processing"]) {
      assert.equal(rideCustomerCancelable(s), false);
    }
  });

  it("ends the ride on a no-show only once the rider is at the pickup", () => {
    const ride = { type: "ride", status: "pickup" };
    assert.equal(isPassengerNoShow(ride, "passenger_no_show"), true);
    assert.equal(isPassengerNoShow(ride, "vehicle_issue"), false);
    assert.equal(isPassengerNoShow({ ...ride, status: "heading_to_store" }, "passenger_no_show"), false);
    assert.equal(isPassengerNoShow({ ...ride, type: "courier" }, "passenger_no_show"), false);
  });
});

describe("riderCanTakeRide", () => {
  const ride = (femaleOnly: boolean) => ({ type: "ride", ride: { female_rider_only: femaleOnly } });

  it("needs a motorcycle", () => {
    assert.equal(riderCanTakeRide(ride(false), { vehicleType: "motorcycle", gender: "male" }), true);
    assert.equal(riderCanTakeRide(ride(false), { vehicleType: "bicycle", gender: "male" }), false);
    assert.equal(riderCanTakeRide(ride(false), { vehicleType: null, gender: "female" }), false);
    assert.equal(rideRiderProblem(ride(false), { vehicleType: "bicycle", gender: "female" }), "vehicle");
  });

  it("needs a woman when the customer asked for a female rider", () => {
    assert.equal(riderCanTakeRide(ride(true), { vehicleType: "motorcycle", gender: "female" }), true);
    assert.equal(riderCanTakeRide(ride(true), { vehicleType: "motorcycle", gender: "male" }), false);
    assert.equal(riderCanTakeRide(ride(true), { vehicleType: "motorcycle", gender: null }), false);
    assert.equal(rideRiderProblem(ride(true), { vehicleType: "motorcycle", gender: "male" }), "gender");
  });

  it("lets anyone on a motorcycle take an ordinary ride", () => {
    assert.equal(riderCanTakeRide({ type: "ride", ride: null }, { vehicleType: "motorcycle", gender: null }), true);
  });
});

describe("no-show wait", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const arrived = (msAgo: number) => ({ arrived_at: new Date(now - msAgo).toISOString() });

  it("is five minutes from the rider's arrival", () => {
    assert.equal(RIDE_NO_SHOW_WAIT_MS, 5 * 60 * 1000);
    assert.equal(noShowWaitLeftMs(arrived(0), now), RIDE_NO_SHOW_WAIT_MS);
    assert.equal(noShowWaitLeftMs(arrived(60_000), now), 4 * 60 * 1000);
    assert.equal(noShowWaitLeftMs(arrived(RIDE_NO_SHOW_WAIT_MS - 1), now), 1);
  });

  it("is over at five minutes and after", () => {
    assert.equal(noShowWaitLeftMs(arrived(RIDE_NO_SHOW_WAIT_MS), now), 0);
    assert.equal(noShowWaitLeftMs(arrived(60 * 60 * 1000), now), 0);
  });

  it("can't be proven without an arrival time (the whole wait is left)", () => {
    assert.equal(noShowWaitLeftMs({ arrived_at: null }, now), RIDE_NO_SHOW_WAIT_MS);
    assert.equal(noShowWaitLeftMs({ arrived_at: "not a date" }, now), RIDE_NO_SHOW_WAIT_MS);
    assert.equal(noShowWaitLeftMs(null, now), RIDE_NO_SHOW_WAIT_MS);
  });

  it("never asks for more than the wait (an arrival stamped ahead of the clock)", () => {
    assert.equal(noShowWaitLeftMs(arrived(-60_000), now), RIDE_NO_SHOW_WAIT_MS);
  });

  it("a report without an arrival time starts the clock (so the next one can succeed)", () => {
    const nowIso = new Date(now).toISOString();
    const r = buildRideDetails(input(), estimate);
    const started = startNoShowClock(r, nowIso);
    assert.ok(started);
    assert.equal(started.arrived_at, nowIso);
    // Nothing else changes.
    assert.deepEqual({ ...started, arrived_at: null }, r);
    // Unreadable counts as missing.
    assert.equal(startNoShowClock({ ...r, arrived_at: "not a date" }, nowIso)?.arrived_at, nowIso);
    // Once stamped, the wait runs from it: the whole wait now, none after 5 min.
    assert.equal(noShowWaitLeftMs(started, now), RIDE_NO_SHOW_WAIT_MS);
    assert.equal(noShowWaitLeftMs(started, now + RIDE_NO_SHOW_WAIT_MS), 0);
  });

  it("an arrival time already stamped is kept (the clock runs from it)", () => {
    const r = { ...buildRideDetails(input(), estimate), ...arrived(60_000) };
    assert.equal(startNoShowClock(r, new Date(now).toISOString()), null);
    assert.equal(startNoShowClock(null, new Date(now).toISOString()), null);
  });
});

describe("rideCanPickUp", () => {
  it("boards the passenger only after the rider reported arriving", () => {
    assert.equal(rideCanPickUp("pickup"), true);
    assert.equal(rideCanPickUp("heading_to_store"), false);
    assert.equal(rideCanPickUp("preparation"), false);
    assert.equal(rideCanPickUp("on_the_way"), false);
  });
});

describe("isRideCustomerCancelReason", () => {
  it("accepts the customer's keys", () => {
    for (const r of ["rider_asked", "changed_mind", "accidental", "waiting_too_long", "other"]) {
      assert.equal(isRideCustomerCancelReason(r), true);
    }
  });

  it("refuses system / rider keys and anything else", () => {
    for (const r of ["no_rider", "passenger_no_show", "canceled_by_customer", "Changed_Mind", ""]) {
      assert.equal(isRideCustomerCancelReason(r), false);
    }
  });
});
