import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCourierDetails,
  COURIER_SEARCH_TIMEOUT_MS,
  courierItems,
  courierLiveAt,
  courierOf,
  currentDropOffIndex,
  deliverCurrentDropOff,
  dropOffSummary,
  isCourierSearchExpired,
  MIN_SCHEDULE_LEAD_MS,
  remainingDropOffs,
  riderCanTake,
  scheduleError,
  type CourierRouteInput,
} from "./courier";

const route = (drops = 2): CourierRouteInput => ({
  pickup: { label: " Grande Poste ", address: "Bd Khemisti, Alger", lat: 36.77, lng: 3.06, contact_name: "  ", note: "Gate B" },
  drop_offs: Array.from({ length: drops }, (_, i) => ({
    label: i === 0 ? "" : `Stop ${i}`,
    address: `Address ${i}`,
    lat: 36.7 + i / 100,
    lng: 3.0,
    recipient_name: " Amina ",
    recipient_phone: "0550 00 00 0" + i,
  })),
  parcel: { type: "documents", size: "small", note: "" },
});

describe("buildCourierDetails", () => {
  it("trims, nulls empty optionals and starts every drop-off undelivered", () => {
    const c = buildCourierDetails(route(), "recipient", 6.4);
    assert.equal(c.pickup.label, "Grande Poste");
    assert.equal(c.pickup.contact_name, null);
    assert.equal(c.pickup.note, "Gate B");
    assert.equal(c.parcel.note, null);
    assert.equal(c.paid_by, "recipient");
    assert.equal(c.distance_km, 6.4);
    assert.equal(c.drop_offs[0].recipient_name, "Amina");
    assert.ok(c.drop_offs.every((d) => d.delivered_at === null));
  });

  it("falls back to the address when a point has no label", () => {
    const c = buildCourierDetails(route(), "sender", 1);
    assert.equal(c.drop_offs[0].label, "Address 0");
  });
});

describe("drop-off progression", () => {
  it("walks the drop-offs in order and flags the last one", () => {
    let c = buildCourierDetails(route(3), "sender", 5);
    assert.equal(currentDropOffIndex(c), 0);
    assert.equal(remainingDropOffs(c), 3);

    const first = deliverCurrentDropOff(c, "2026-10-09T10:00:00.000Z")!;
    assert.equal(first.index, 0);
    assert.equal(first.last, false);
    c = first.courier;
    assert.equal(c.drop_offs[0].delivered_at, "2026-10-09T10:00:00.000Z");
    assert.equal(currentDropOffIndex(c), 1);

    c = deliverCurrentDropOff(c, "t2")!.courier;
    const last = deliverCurrentDropOff(c, "t3")!;
    assert.equal(last.index, 2);
    assert.equal(last.last, true);
    assert.equal(currentDropOffIndex(last.courier), null);
    assert.equal(deliverCurrentDropOff(last.courier, "t4"), null);
  });

  it("does not mutate the input", () => {
    const c = buildCourierDetails(route(1), "sender", 1);
    deliverCurrentDropOff(c, "t");
    assert.equal(c.drop_offs[0].delivered_at, null);
  });

  it("treats a missing courier as nothing to deliver", () => {
    assert.equal(currentDropOffIndex(null), null);
    assert.equal(remainingDropOffs(null), 0);
    assert.equal(courierOf({ courier: null }), null);
    assert.equal(courierOf({ courier: { pickup: {} } }), null);
  });
});

describe("isCourierSearchExpired", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  const base = { type: "courier", status: "searching", rider_id: null };
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("expires an unclaimed request past the search window", () => {
    assert.equal(isCourierSearchExpired({ ...base, created_at: ago(COURIER_SEARCH_TIMEOUT_MS + 1000) }, now), true);
    assert.equal(isCourierSearchExpired({ ...base, created_at: ago(COURIER_SEARCH_TIMEOUT_MS - 1000) }, now), false);
  });

  it("counts a scheduled request from its scheduled time", () => {
    const o = { ...base, created_at: ago(3 * 60 * 60 * 1000), scheduled_at: ago(5 * 60 * 1000) };
    assert.equal(courierLiveAt(o), now - 5 * 60 * 1000);
    assert.equal(isCourierSearchExpired(o, now), false);
  });

  it("restarts the window when a rider dropped it back into the pool", () => {
    const o = { ...base, created_at: ago(60 * 60 * 1000), accepted_at: ago(60 * 1000) };
    assert.equal(isCourierSearchExpired(o, now), false);
  });

  it("never expires a claimed, moved-on or non-courier order", () => {
    const old = ago(COURIER_SEARCH_TIMEOUT_MS * 3);
    assert.equal(isCourierSearchExpired({ ...base, created_at: old, rider_id: "r1" }, now), false);
    assert.equal(isCourierSearchExpired({ ...base, created_at: old, status: "on_the_way" }, now), false);
    assert.equal(isCourierSearchExpired({ ...base, created_at: old, type: "merchant" }, now), false);
  });
});

describe("scheduleError", () => {
  const now = Date.parse("2026-10-09T12:00:00.000Z");
  it("accepts now (no schedule) and a time far enough ahead", () => {
    assert.equal(scheduleError(undefined, now), null);
    assert.equal(scheduleError(new Date(now + MIN_SCHEDULE_LEAD_MS + 1000).toISOString(), now), null);
  });
  it("refuses past, too-soon and too-far times", () => {
    assert.ok(scheduleError(new Date(now - 1000).toISOString(), now));
    assert.ok(scheduleError(new Date(now + 60 * 1000).toISOString(), now));
    assert.ok(scheduleError(new Date(now + 8 * 24 * 60 * 60 * 1000).toISOString(), now));
  });
});

describe("items / summary", () => {
  it("lists one item per drop-off and summarizes multi-stop routes", () => {
    const c = buildCourierDetails(route(3), "sender", 5);
    assert.equal(courierItems(c).length, 3);
    assert.deepEqual(courierItems(c)[1], { name: "Stop 1", quantity: 1, unit_price: 0 });
    assert.equal(dropOffSummary(c), "Stop 2 +2");
  });
});

describe("riderCanTake", () => {
  it("keeps motorcycle requests away from bicycles only", () => {
    assert.equal(riderCanTake("motorcycle", "bicycle"), false);
    assert.equal(riderCanTake("motorcycle", "motorcycle"), true);
    assert.equal(riderCanTake("bicycle", "motorcycle"), true);
    assert.equal(riderCanTake("bicycle", "bicycle"), true);
    assert.equal(riderCanTake(null, "bicycle"), true);
    assert.equal(riderCanTake("motorcycle", null), true);
  });
});
