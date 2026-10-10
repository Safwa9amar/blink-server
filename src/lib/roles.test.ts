import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderStatus, userRole } from "../db/schema/enums";
import {
  APP_ROLES,
  canActivate,
  canLeaveRole,
  FINAL_ORDER_STATUSES,
  grantRole,
  initialGrantedRoles,
  leavesRider,
  normalizeGranted,
  roleConflictMessage,
  signUpConflict,
} from "./roles";

describe("normalizeGranted", () => {
  it("always holds customer and the active role, deduplicated, in enum order", () => {
    assert.deepEqual(normalizeGranted(["agent", "rider", "rider"], "merchant"), [
      "customer",
      "rider",
      "merchant",
      "agent",
    ]);
  });
  it("drops unknown values and survives a missing list", () => {
    assert.deepEqual(normalizeGranted(["super_admin", "rider"]), ["customer", "rider"]);
    assert.deepEqual(normalizeGranted(null), ["customer"]);
    assert.deepEqual(normalizeGranted(undefined, "agent"), ["customer", "agent"]);
  });
});

describe("initialGrantedRoles", () => {
  it("is the role chosen at sign-up plus customer", () => {
    assert.deepEqual(initialGrantedRoles("rider"), ["customer", "rider"]);
    assert.deepEqual(initialGrantedRoles("customer"), ["customer"]);
  });
});

describe("grantRole", () => {
  it("adds a role", () => {
    assert.deepEqual(grantRole(["customer"], "agent"), { granted: ["customer", "agent"], added: true });
  });
  it("is idempotent", () => {
    assert.deepEqual(grantRole(["customer", "agent"], "agent"), {
      granted: ["customer", "agent"],
      added: false,
    });
  });
  it("normalizes a stored list that lacks customer", () => {
    assert.deepEqual(grantRole(["rider"], "merchant"), {
      granted: ["customer", "rider", "merchant"],
      added: true,
    });
  });
});

describe("canActivate", () => {
  it("allows granted roles only", () => {
    assert.equal(canActivate(["customer", "rider"], "rider"), true);
    assert.equal(canActivate(["customer", "rider"], "agent"), false);
  });
  it("always allows customer", () => {
    assert.equal(canActivate([], "customer"), true);
  });
  it("rejects unknown roles", () => {
    assert.equal(canActivate(["customer"], "super_admin"), false);
  });
});

describe("leavesRider", () => {
  it("is true only when switching away from rider", () => {
    assert.equal(leavesRider("rider", "customer"), true);
    assert.equal(leavesRider("rider", "rider"), false);
    assert.equal(leavesRider("customer", "rider"), false);
    assert.equal(leavesRider(undefined, "customer"), false);
  });
});

describe("canLeaveRole", () => {
  it("blocks leaving rider while any job is assigned (in progress or booked)", () => {
    assert.equal(canLeaveRole("rider", "customer", { activeJobCount: 1 }), false);
    assert.equal(canLeaveRole("rider", "merchant", { activeJobCount: 3 }), false);
  });
  it("lets a rider with no assigned job leave", () => {
    assert.equal(canLeaveRole("rider", "customer", { activeJobCount: 0 }), true);
  });
  it("never blocks when not leaving rider", () => {
    assert.equal(canLeaveRole("rider", "rider", { activeJobCount: 2 }), true);
    assert.equal(canLeaveRole("customer", "rider", { activeJobCount: 2 }), true);
    assert.equal(canLeaveRole("merchant", "customer", { activeJobCount: 5 }), true);
  });
  it("final order statuses are real order_status enum values", () => {
    for (const status of FINAL_ORDER_STATUSES) {
      assert.ok((orderStatus.enumValues as readonly string[]).includes(status), status);
    }
  });
});

describe("enum alignment", () => {
  it("APP_ROLES matches the user_role enum", () => {
    assert.deepEqual([...APP_ROLES], [...userRole.enumValues]);
  });
});

describe("edge cases", () => {
  it("normalizeGranted ignores an unknown active role and wrong-case values", () => {
    assert.deepEqual(normalizeGranted([], "super_admin"), ["customer"]);
    assert.deepEqual(normalizeGranted(["Rider"]), ["customer"]);
  });
  it("grantRole refuses non-partner roles", () => {
    assert.deepEqual(grantRole(["customer"], "customer" as any), { granted: ["customer"], added: false });
    assert.deepEqual(grantRole(["customer"], "admin" as any), { granted: ["customer"], added: false });
  });
  it("canActivate: customer always; callers must normalise with the active role", () => {
    assert.equal(canActivate(null, "customer"), true);
    assert.equal(canActivate(["customer"], "rider"), false);
    assert.equal(canActivate(normalizeGranted(["customer"], "rider"), "rider"), true);
  });
});

describe("signUpConflict", () => {
  it("conflicts only when the account doesn't hold the chosen role", () => {
    assert.equal(signUpConflict({ role: "customer", granted_roles: ["customer", "rider"] }, "rider"), false);
    assert.equal(signUpConflict({ role: "customer", granted_roles: ["customer"] }, "rider"), true);
    assert.equal(signUpConflict({ role: "rider", granted_roles: null }, "rider"), false);
    assert.equal(signUpConflict({ role: "rider", granted_roles: null }, "customer"), false);
    assert.equal(signUpConflict({ role: "rider", granted_roles: null }, "admin"), true);
  });
  it("its message points to Become a Partner", () => {
    assert.match(roleConflictMessage("customer", "rider"), /Become a Partner/);
    assert.match(roleConflictMessage("customer", "rider"), /Customer/);
  });
});
