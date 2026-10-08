import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACCEPT_GRACE_MS,
  acceptPatch,
  answersRequest,
  claimRollback,
  CLEAR_OFFER,
  heldRequestTargets,
  heldSinceIso,
  isHeld,
  isHeldForOtherRider,
  isLiveOffer,
  isOfferedTo,
  isRequestVisibleTo,
  isScheduledBooking,
  liveSinceIso,
  offerExpiresAt,
  offerStatus,
  poolClaimPatch,
  requestFields,
  RIDER_OFFER_TTL_MS,
  riderAvailability,
  withoutOffer,
} from "./rider-offer";

const T0 = Date.parse("2026-10-07T17:00:00.000Z");
const NOW_ISO = "2026-10-07T17:00:30.000Z";

const order = (o: Record<string, unknown> = {}) => ({
  id: "o1",
  type: "merchant",
  status: "searching",
  merchant_status: "ready",
  rider_id: null,
  scheduled_at: null,
  offered_rider_id: "r1",
  offered_driver_id: null,
  offered_mode: "blink",
  offered_at: new Date(T0).toISOString(),
  offer_declined_at: null,
  ...o,
});

describe("request lifetime", () => {
  it("is live until offered_at + TTL, then held for the accept grace", () => {
    const o = order();
    assert.equal(isLiveOffer(o, T0 + RIDER_OFFER_TTL_MS - 1), true);
    assert.equal(isLiveOffer(o, T0 + RIDER_OFFER_TTL_MS), false);
    assert.equal(isHeld(o, T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS - 1), true);
    assert.equal(isHeld(o, T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS), false);
  });

  it("is never live once declined, assigned, or no longer searching", () => {
    assert.equal(isHeld(order({ offer_declined_at: NOW_ISO }), T0 + 1000), false);
    assert.equal(isHeld(order({ rider_id: "r9" }), T0 + 1000), false);
    assert.equal(isHeld(order({ status: "heading_to_store" }), T0 + 1000), false);
    assert.equal(isHeld(order({ status: "canceled" }), T0 + 1000), false);
    assert.equal(isHeld(order({ offered_rider_id: null }), T0 + 1000), false);
    assert.equal(isHeld(order({ offered_at: null }), T0 + 1000), false);
  });

  it("offerExpiresAt is the TTL deadline while live, else null", () => {
    assert.equal(offerExpiresAt(order(), T0 + 1000), new Date(T0 + RIDER_OFFER_TTL_MS).toISOString());
    assert.equal(offerExpiresAt(order(), T0 + RIDER_OFFER_TTL_MS), null);
    assert.equal(offerExpiresAt(order({ offer_declined_at: NOW_ISO }), T0 + 1000), null);
  });
});

describe("who may see / take the order", () => {
  it("only the requested rider sees the request, and only while live", () => {
    assert.equal(isRequestVisibleTo(order(), "r1", T0 + 1000), true);
    assert.equal(isRequestVisibleTo(order(), "r2", T0 + 1000), false);
    assert.equal(isRequestVisibleTo(order(), "r1", T0 + RIDER_OFFER_TTL_MS + 1), false);
  });

  it("the requested rider may accept within TTL + grace; other riders are held off as long", () => {
    const late = T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS - 1;
    assert.equal(isOfferedTo(order(), "r1", late), true);
    assert.equal(isHeldForOtherRider(order(), "r2", late), true);
    assert.equal(isHeldForOtherRider(order(), "r1", late), false);
    const after = T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS;
    assert.equal(isOfferedTo(order(), "r1", after), false);
    assert.equal(isHeldForOtherRider(order(), "r2", after), false);
  });

  it("a declined request holds nobody and can't be accepted", () => {
    const declined = order({ offer_declined_at: NOW_ISO });
    assert.equal(isOfferedTo(declined, "r1", T0 + 1000), false);
    assert.equal(isHeldForOtherRider(declined, "r2", T0 + 1000), false);
  });
});

describe("offerStatus (merchant view)", () => {
  it("pending → expired, declined wins, null when assigned or no request", () => {
    assert.equal(offerStatus(order(), T0 + 1000), "pending");
    assert.equal(offerStatus(order(), T0 + RIDER_OFFER_TTL_MS), "expired");
    assert.equal(offerStatus(order({ offer_declined_at: NOW_ISO }), T0 + 1000), "declined");
    assert.equal(offerStatus(order({ rider_id: "r1", status: "heading_to_store" }), T0 + 1000), null);
    assert.equal(offerStatus(order({ offered_rider_id: null }), T0 + 1000), null);
    assert.equal(offerStatus(order({ status: "canceled" }), T0 + 1000), null);
  });
});

describe("acceptPatch (targeted accept)", () => {
  it("blink request → Blink delivery, heading_to_store, request cleared", () => {
    assert.deepEqual(acceptPatch(order(), "r1", NOW_ISO, { scheduled: false }), {
      rider_id: "r1",
      rider_assigned_at: NOW_ISO,
      status: "heading_to_store",
      delivery_mode: "blink",
      store_driver_id: null,
      ...CLEAR_OFFER,
    });
  });

  it("own request → the store's driver delivers (store_driver_id from the request)", () => {
    const patch = acceptPatch(
      order({ offered_mode: "own", offered_driver_id: "d1" }),
      "r1",
      NOW_ISO,
      { scheduled: false }
    );
    assert.equal(patch?.delivery_mode, "own");
    assert.equal(patch?.store_driver_id, "d1");
    assert.equal(patch?.offered_mode, null);
  });

  it("refuses an own request whose driver row is gone, and a request with no mode", () => {
    assert.equal(acceptPatch(order({ offered_mode: "own", offered_driver_id: null }), "r1", NOW_ISO, { scheduled: false }), null);
    assert.equal(acceptPatch(order({ offered_mode: null }), "r1", NOW_ISO, { scheduled: false }), null);
  });

  it("never infers the mode from the driver id", () => {
    const patch = acceptPatch(order({ offered_mode: "blink", offered_driver_id: "d1" }), "r1", NOW_ISO, { scheduled: false });
    assert.equal(patch?.delivery_mode, "blink");
    assert.equal(patch?.store_driver_id, null);
  });

  it("a scheduled booking keeps status searching", () => {
    const patch = acceptPatch(order(), "r1", NOW_ISO, { scheduled: true });
    assert.equal("status" in (patch ?? {}), false);
  });
});

describe("poolClaimPatch", () => {
  it("merchant order → Blink delivery, clears any stale request + store driver", () => {
    assert.deepEqual(poolClaimPatch(order({ offer_declined_at: NOW_ISO }), "r2", NOW_ISO, { scheduled: false }), {
      rider_id: "r2",
      rider_assigned_at: NOW_ISO,
      status: "heading_to_store",
      delivery_mode: "blink",
      store_driver_id: null,
      ...CLEAR_OFFER,
    });
  });

  it("shopper / courier orders get no delivery mode", () => {
    const patch = poolClaimPatch(order({ type: "courier", offered_rider_id: null }), "r2", NOW_ISO, { scheduled: false });
    assert.equal("delivery_mode" in patch, false);
    assert.equal("store_driver_id" in patch, false);
  });
});

describe("isScheduledBooking", () => {
  it("only scheduled more than 30 minutes ahead", () => {
    assert.equal(isScheduledBooking({ scheduled_at: null }, T0), false);
    assert.equal(isScheduledBooking({ scheduled_at: new Date(T0 + 31 * 60_000).toISOString() }, T0), true);
    assert.equal(isScheduledBooking({ scheduled_at: new Date(T0 + 29 * 60_000).toISOString() }, T0), false);
  });
});

describe("answersRequest (request identity on accept / decline)", () => {
  const shown = new Date(T0 + RIDER_OFFER_TTL_MS).toISOString(); // request_expires_at the rider saw

  it("matches the exact request the rider was shown, through the grace window", () => {
    assert.equal(answersRequest(order(), "r1", shown, T0 + 1000), true);
    assert.equal(answersRequest(order(), "r1", shown, T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS - 1), true);
  });

  it("never matches a lapsed, re-sent, declined, withdrawn or someone else's request", () => {
    assert.equal(answersRequest(order(), "r1", shown, T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS), false);
    const resent = order({ offered_at: new Date(T0 + 5000).toISOString() });
    assert.equal(answersRequest(resent, "r1", shown, T0 + 6000), false);
    assert.equal(answersRequest(order({ offer_declined_at: NOW_ISO }), "r1", shown, T0 + 1000), false);
    assert.equal(answersRequest(order({ offered_rider_id: null, offered_at: null }), "r1", shown, T0 + 1000), false);
    assert.equal(answersRequest(order(), "r2", shown, T0 + 1000), false);
  });

  it("accepts any ISO spelling of the same instant, rejects garbage", () => {
    assert.equal(answersRequest(order(), "r1", "2026-10-07T17:02:00+00:00", T0 + 1000), true);
    assert.equal(answersRequest(order(), "r1", "not-a-date", T0 + 1000), false);
  });
});

describe("withoutOffer", () => {
  it("nulls every request column and keeps the rest", () => {
    const masked = withoutOffer(order({ offered_mode: "own", offered_driver_id: "d1", offer_declined_at: NOW_ISO }));
    assert.deepEqual({ ...masked, ...CLEAR_OFFER }, masked);
    assert.equal(masked.id, "o1");
    assert.equal(masked.status, "searching");
  });
});

describe("database filter bounds", () => {
  // Routes filter with `offered_at > liveSinceIso(now)` / `> heldSinceIso(now)`;
  // they must select exactly the live / held requests.
  const at = (iso: string, deltaMs: number) =>
    order({ offered_at: new Date(Date.parse(iso) + deltaMs).toISOString() });
  const now = T0 + 5 * 60_000;

  it("offered_at > liveSinceIso(now) ⟺ isLiveOffer", () => {
    assert.equal(isLiveOffer(at(liveSinceIso(now), 0), now), false);
    assert.equal(isLiveOffer(at(liveSinceIso(now), 1), now), true);
  });

  it("offered_at > heldSinceIso(now) ⟺ isHeld", () => {
    assert.equal(isHeld(at(heldSinceIso(now), 0), now), false);
    assert.equal(isHeld(at(heldSinceIso(now), 1), now), true);
  });
});

describe("requestFields (RiderJob request_kind / request_expires_at)", () => {
  it("the requested rider gets the kind and the deadline while the request is live", () => {
    assert.deepEqual(requestFields(order(), "r1", T0 + 1000), {
      request_kind: "blink",
      request_expires_at: new Date(T0 + RIDER_OFFER_TTL_MS).toISOString(),
    });
    const own = order({ offered_mode: "own", offered_driver_id: "d1" });
    assert.equal(requestFields(own, "r1", T0 + 1000).request_kind, "own");
  });

  it("null for other riders, no viewer, after the TTL, once declined or assigned, or with no mode", () => {
    const none = { request_kind: null, request_expires_at: null };
    assert.deepEqual(requestFields(order(), "r2", T0 + 1000), none);
    assert.deepEqual(requestFields(order(), undefined, T0 + 1000), none);
    // In the accept grace the request is still claimable but no longer shown.
    assert.deepEqual(requestFields(order(), "r1", T0 + RIDER_OFFER_TTL_MS), none);
    assert.deepEqual(requestFields(order({ offer_declined_at: NOW_ISO }), "r1", T0 + 1000), none);
    assert.deepEqual(requestFields(order({ rider_id: "r1", status: "heading_to_store" }), "r1", T0 + 1000), none);
    assert.deepEqual(requestFields(order({ offered_mode: null }), "r1", T0 + 1000), none);
  });
});

describe("claimRollback", () => {
  const snapshot = (o: Record<string, unknown> = {}) =>
    order({ delivery_mode: null, store_driver_id: null, rider_assigned_at: null, ...o });

  it("undoes a targeted accept, the request included", () => {
    const snap = snapshot({ offered_mode: "own", offered_driver_id: "d1" });
    const claimed = { ...snap, ...acceptPatch(snap, "r1", NOW_ISO, { scheduled: false }) };
    assert.deepEqual({ ...claimed, ...claimRollback(snap) }, snap);
  });

  it("undoes a pool claim over a declined request (the merchant still sees declined)", () => {
    const snap = snapshot({ offer_declined_at: NOW_ISO });
    const claimed = { ...snap, ...poolClaimPatch(snap, "r2", NOW_ISO, { scheduled: false }) };
    const restored = { ...claimed, ...claimRollback(snap) };
    assert.deepEqual(restored, snap);
    assert.equal(offerStatus(restored, T0 + 1000), "declined");
  });

  it("leaves the delivery fields alone on shopper / courier orders", () => {
    const rollback = claimRollback(snapshot({ type: "courier", offered_rider_id: null, offered_mode: null, offered_at: null }));
    assert.equal("delivery_mode" in rollback, false);
    assert.equal("store_driver_id" in rollback, false);
    assert.equal(rollback.status, "searching");
  });
});

describe("riderAvailability", () => {
  it("needs an online profile; busy or requested elsewhere counts as busy", () => {
    assert.equal(riderAvailability({ isAvailable: true, busy: false, requestedElsewhere: false }), "available");
    assert.equal(riderAvailability({ isAvailable: undefined, busy: false, requestedElsewhere: false }), "offline");
    assert.equal(riderAvailability({ isAvailable: false, busy: true, requestedElsewhere: false }), "offline");
    assert.equal(riderAvailability({ isAvailable: true, busy: true, requestedElsewhere: false }), "busy");
    assert.equal(riderAvailability({ isAvailable: true, busy: false, requestedElsewhere: true }), "busy");
  });
});

describe("heldRequestTargets", () => {
  it("splits this order's target from riders held by another order's request", () => {
    const rows = [
      order({ id: "o1", offered_rider_id: "r1" }),
      order({ id: "o2", offered_rider_id: "r2" }),
    ];
    const { here, elsewhere } = heldRequestTargets(rows, "o1", T0 + 1000);
    assert.deepEqual([...here], ["r1"]);
    assert.deepEqual([...elsewhere], ["r2"]);
  });

  it("still holds during the accept grace, then lets go", () => {
    const rows = [order({ id: "o2", offered_rider_id: "r2" })];
    const grace = T0 + RIDER_OFFER_TTL_MS + ACCEPT_GRACE_MS - 1;
    assert.deepEqual([...heldRequestTargets(rows, "o1", grace).elsewhere], ["r2"]);
    assert.equal(heldRequestTargets(rows, "o1", grace + 1).elsewhere.size, 0);
  });

  it("ignores declined, assigned and closed orders", () => {
    const rows = [
      order({ id: "o2", offered_rider_id: "r2", offer_declined_at: NOW_ISO }),
      order({ id: "o3", offered_rider_id: "r3", rider_id: "r3", status: "heading_to_store" }),
      order({ id: "o4", offered_rider_id: "r4", status: "canceled" }),
    ];
    const { here, elsewhere } = heldRequestTargets(rows, "o1", T0 + 1000);
    assert.equal(here.size + elsewhere.size, 0);
  });

  it("without an order every held request counts as elsewhere", () => {
    const { here, elsewhere } = heldRequestTargets([order({ id: "o1", offered_rider_id: "r1" })], undefined, T0 + 1000);
    assert.equal(here.size, 0);
    assert.deepEqual([...elsewhere], ["r1"]);
  });
});
