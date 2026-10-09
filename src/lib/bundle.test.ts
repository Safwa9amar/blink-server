import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUNDLE_STORE_TIMEOUT_MS,
  bundleAnswersRequest,
  bundleClaimComplete,
  bundleHeldForOtherRider,
  bundleOfferedTo,
  bundleRequestVisibleTo,
  canAssignOwnDriver,
  bundleMembers,
  bundleStatus,
  canCancelBundle,
  canDeliverBundle,
  isBundleMember,
  isBundleOfferable,
  isStoreTimedOut,
  leadOrder,
  orderStops,
} from "./bundle";
import { RIDER_OFFER_TTL_MS } from "./rider-offer";

const order = (o: Record<string, unknown>) => ({
  id: "o1",
  checkout_id: "c1",
  type: "merchant",
  status: "searching",
  merchant_status: "accepted",
  rider_id: null,
  subtotal: 100,
  created_at: "2026-10-07T10:00:00.000Z",
  ...o,
});

describe("bundleMembers / isBundleMember", () => {
  it("drops canceled and merchant_rejected orders", () => {
    const rows = [order({ id: "a" }), order({ id: "b", status: "canceled" }), order({ id: "c", status: "merchant_rejected" })];
    assert.deepEqual(bundleMembers(rows).map((o) => o.id), ["a"]);
    assert.equal(isBundleMember(order({ status: "delivered" })), true);
  });
});

describe("leadOrder", () => {
  it("picks the largest subtotal, ties → smallest id", () => {
    assert.equal(leadOrder([order({ id: "b", subtotal: 50 }), order({ id: "a", subtotal: 90 })]).id, "a");
    assert.equal(leadOrder([order({ id: "z", subtotal: 90 }), order({ id: "m", subtotal: 90 })]).id, "m");
  });
  it("reads numeric strings (Postgres numeric)", () => {
    assert.equal(leadOrder([order({ id: "a", subtotal: "9.50" }), order({ id: "b", subtotal: "10.00" })]).id, "b");
  });
});

describe("isBundleOfferable", () => {
  it("true when every member is searching, unassigned and accepted/ready or shopper", () => {
    assert.equal(
      isBundleOfferable([
        order({ id: "a", merchant_status: "accepted" }),
        order({ id: "b", merchant_status: "ready" }),
        order({ id: "c", type: "shopper", merchant_status: "rejected" }),
        order({ id: "d", status: "merchant_rejected", merchant_status: "rejected" }),
      ]),
      true
    );
  });
  it("false while a store is still pending", () => {
    assert.equal(isBundleOfferable([order({ id: "a" }), order({ id: "b", status: "processing", merchant_status: "pending" })]), false);
  });
  it("false once a rider holds any member", () => {
    assert.equal(isBundleOfferable([order({ id: "a" }), order({ id: "b", rider_id: "r1" })]), false);
  });
  it("false when every store rejected", () => {
    assert.equal(isBundleOfferable([order({ status: "merchant_rejected" })]), false);
  });
  it("false for merchant members on the store's own driver", () => {
    assert.equal(isBundleOfferable([order({ id: "a", delivery_mode: "own" })]), false);
  });
});

describe("bundleStatus", () => {
  it("is the least advanced member's status", () => {
    assert.equal(bundleStatus([order({ status: "on_the_way" }), order({ status: "pickup" })]), "pickup");
    assert.equal(bundleStatus([order({ status: "on_the_way" }), order({ status: "heading_to_store" })]), "heading_to_store");
    assert.equal(bundleStatus([order({ status: "delivered" }), order({ status: "delivered" })]), "delivered");
    assert.equal(bundleStatus([order({ status: "searching" }), order({ status: "searching" })]), "searching");
  });
});

describe("canDeliverBundle / canCancelBundle", () => {
  it("deliver only when every member is on the way", () => {
    assert.equal(canDeliverBundle([order({ status: "on_the_way" }), order({ status: "on_the_way" })]), true);
    assert.equal(canDeliverBundle([order({ status: "on_the_way" }), order({ status: "pickup" })]), false);
    assert.equal(canDeliverBundle([]), false);
  });
  it("cancel only before any pickup", () => {
    assert.equal(canCancelBundle([order({ status: "heading_to_store" }), order({ status: "pickup" })]), true);
    assert.equal(canCancelBundle([order({ status: "on_the_way" }), order({ status: "pickup" })]), false);
    assert.equal(canCancelBundle([order({ status: "delivered" })]), false);
  });
});

describe("bundleClaimComplete", () => {
  it("needs every member claimed", () => {
    assert.equal(bundleClaimComplete(3, 3), true);
    assert.equal(bundleClaimComplete(2, 3), false);
    assert.equal(bundleClaimComplete(0, 0), false);
  });
});

describe("isStoreTimedOut", () => {
  const created = Date.parse("2026-10-07T10:00:00.000Z");
  const pending = order({ status: "processing", merchant_status: "pending" });
  it("times out a pending checkout member after 10 minutes", () => {
    assert.equal(isStoreTimedOut(pending, created + BUNDLE_STORE_TIMEOUT_MS + 1), true);
    assert.equal(isStoreTimedOut(pending, created + BUNDLE_STORE_TIMEOUT_MS - 1), false);
  });
  it("ignores single orders, answered stores and canceled orders", () => {
    const late = created + BUNDLE_STORE_TIMEOUT_MS + 1;
    assert.equal(isStoreTimedOut({ ...pending, checkout_id: null }, late), false);
    assert.equal(isStoreTimedOut({ ...pending, merchant_status: "accepted" }, late), false);
    assert.equal(isStoreTimedOut({ ...pending, status: "canceled" }, late), false);
  });
});

describe("orderStops", () => {
  const p = (id: string, lat: number | null, lng: number | null, extra: Record<string, unknown> = {}) => ({
    id,
    lat,
    lng,
    picked_up_at: null as string | null,
    ...extra,
  });
  it("nearest neighbour from the start point, unknown coordinates last", () => {
    const stops = [p("far", 36.9, 3.2), p("none", null, null), p("near", 36.71, 3.01), p("mid", 36.8, 3.1)];
    assert.deepEqual(orderStops(stops, { lat: 36.7, lng: 3.0 }).map((s) => s.id), ["near", "mid", "far", "none"]);
  });
  it("without a start point begins at the first stop", () => {
    const stops = [p("a", 36.9, 3.2), p("b", 36.71, 3.01), p("c", 36.88, 3.18)];
    assert.deepEqual(orderStops(stops, null).map((s) => s.id), ["a", "c", "b"]);
  });
  it("keeps picked-up stops first in pickup order, then continues from the last pickup", () => {
    const stops = [
      p("x", 36.71, 3.01),
      p("y", 36.9, 3.2, { picked_up_at: "2026-10-07T10:20:00Z" }),
      p("z", 36.88, 3.18),
      p("w", 36.8, 3.1, { picked_up_at: "2026-10-07T10:10:00Z" }),
    ];
    assert.deepEqual(orderStops(stops, { lat: 36.7, lng: 3.0 }).map((s) => s.id), ["w", "y", "z", "x"]);
  });
});

describe("own driver for a checkout", () => {
  const T0 = Date.parse("2026-10-09T12:00:00Z");
  const at = new Date(T0).toISOString();
  const m = (over: Record<string, unknown> = {}) => ({
    id: "a",
    type: "merchant",
    rider_id: null,
    status: "searching",
    merchant_status: "ready",
    offered_rider_id: null,
    offered_at: null,
    offer_declined_at: null,
    ...over,
  });
  const asked = (over: Record<string, unknown> = {}) =>
    m({ offered_rider_id: "drv", offered_at: at, offered_mode: "own", offered_driver_id: "d1", ...over });

  it("canAssignOwnDriver: every member accepted/ready, unassigned, store order", () => {
    assert.equal(canAssignOwnDriver([m(), m({ id: "b", merchant_status: "accepted" })]), true);
    assert.equal(canAssignOwnDriver([m(), m({ id: "b", merchant_status: "pending" })]), false);
    assert.equal(canAssignOwnDriver([m(), m({ id: "b", type: "shopper" })]), false);
    assert.equal(canAssignOwnDriver([m(), m({ id: "b", rider_id: "r" })]), false);
    assert.equal(canAssignOwnDriver([]), false);
  });

  it("a request is visible only when every member carries it", () => {
    assert.equal(bundleRequestVisibleTo([asked(), asked({ id: "b" })], "drv", T0 + 1000), true);
    assert.equal(bundleRequestVisibleTo([asked(), m({ id: "b" })], "drv", T0 + 1000), false);
    assert.equal(bundleRequestVisibleTo([asked(), asked({ id: "b" })], "other", T0 + 1000), false);
    assert.equal(
      bundleRequestVisibleTo([asked(), asked({ id: "b" })], "drv", T0 + RIDER_OFFER_TTL_MS + 1),
      false
    );
  });

  it("members with different offered_at are not one request", () => {
    const later = new Date(T0 + 5000).toISOString();
    assert.equal(bundleOfferedTo([asked(), asked({ id: "b", offered_at: later })], "drv", T0 + 6000), false);
  });

  it("answers the request shown by its deadline", () => {
    const deadline = new Date(T0 + RIDER_OFFER_TTL_MS).toISOString();
    const both = [asked(), asked({ id: "b" })];
    assert.equal(bundleAnswersRequest(both, "drv", deadline, T0 + 1000), true);
    assert.equal(bundleAnswersRequest(both, "drv", new Date(T0).toISOString(), T0 + 1000), false);
  });

  it("held for another rider while a request is open", () => {
    const both = [asked(), asked({ id: "b" })];
    assert.equal(bundleHeldForOtherRider(both, "someone", T0 + 1000), true);
    assert.equal(bundleHeldForOtherRider(both, "drv", T0 + 1000), false);
    assert.equal(bundleHeldForOtherRider([m(), m({ id: "b" })], "someone", T0 + 1000), false);
  });
});
