import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildRiderCard, isActiveOrder, isActiveTrip } from "./rider-card";

const user = { first_name: "Dev", last_name: "Rider", profile_picture: "https://x/p.jpg", phone_number: "0555" };
const profile = { rider_id: "BK-RR-100001", vehicle_type: "motorcycle" };
const vehicle = { color: " Black ", license_plate: "23495 926 17" };

describe("buildRiderCard", () => {
  it("profile + vehicle, phone only while active", () => {
    assert.deepEqual(buildRiderCard({ user, profile, vehicle, deliveries: 122 }, "r1", true), {
      id: "r1",
      display_id: "BK-RR-100001",
      name: "Dev Rider",
      avatar: "https://x/p.jpg",
      vehicle_type: "motorcycle",
      vehicle_color: "Black",
      plate: "23495 926 17",
      deliveries: 122,
      phone: "0555",
    });
    assert.equal(buildRiderCard({ user, profile, vehicle }, "r1", false).phone, null);
  });

  it("missing rows → nulls, never a crash", () => {
    assert.deepEqual(buildRiderCard({}, "r1", true), {
      id: "r1",
      display_id: null,
      name: null,
      avatar: null,
      vehicle_type: null,
      vehicle_color: null,
      plate: null,
      deliveries: 0,
      phone: null,
    });
  });
});

describe("active rules (phone sharing)", () => {
  it("trips: upcoming only", () => {
    assert.equal(isActiveTrip({ status: "upcoming" }), true);
    for (const status of ["completed", "canceled", "under_review"]) assert.equal(isActiveTrip({ status }), false);
  });

  it("orders: a rider on it and not closed", () => {
    for (const status of ["searching", "heading_to_store", "preparation", "pickup", "on_the_way"]) {
      assert.equal(isActiveOrder({ status, rider_id: "r1" }), true);
    }
    assert.equal(isActiveOrder({ status: "on_the_way", rider_id: null }), false);
    for (const status of ["delivered", "canceled", "merchant_rejected"]) {
      assert.equal(isActiveOrder({ status, rider_id: "r1" }), false);
    }
  });
});
