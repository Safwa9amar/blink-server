import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  changedColumns,
  isMaterialChange,
  newPackStatus,
  onStaffHold,
  resolvePackUpdate,
  resolveStaffPackReview,
  sameItems,
  type PackReviewState,
} from "./pack-review";

const item = (product_id: string, quantity = 1, promo?: [number, number]) => ({
  product_id,
  quantity,
  qty_promo_enabled: !!promo,
  buy_qty: promo?.[0] ?? 2,
  get_qty: promo?.[1] ?? 1,
});

const pack = (over: Partial<PackReviewState> = {}): PackReviewState => ({
  status: "active",
  free_delivery: true,
  discount_enabled: true,
  discount_percent: 10,
  items: [item("a"), item("b", 2)],
  reviewed_at: "2026-10-01T10:00:00.000Z",
  review_note: null,
  ...over,
});

describe("sameItems", () => {
  it("ignores line order", () => {
    assert.ok(sameItems([item("a"), item("b", 2)], [item("b", 2), item("a")]));
  });
  it("sees a quantity, product or promo change", () => {
    assert.ok(!sameItems([item("a")], [item("a", 2)]));
    assert.ok(!sameItems([item("a")], [item("c")]));
    assert.ok(!sameItems([item("a")], [item("a", 1, [2, 1])]));
    assert.ok(!sameItems([item("a")], [item("a"), item("b")]));
  });
  it("ignores buy/get values while the promo is off", () => {
    assert.ok(sameItems([{ ...item("a"), buy_qty: 5 }], [item("a")]));
  });
});

describe("isMaterialChange", () => {
  it("is false for name-only edits and unchanged values", () => {
    assert.equal(isMaterialChange(pack(), {}), false);
    assert.equal(
      isMaterialChange(pack(), { items: [item("b", 2), item("a")], free_delivery: true, discount_percent: 10 }),
      false
    );
  });
  it("is true for items, discount or free delivery changes", () => {
    assert.equal(isMaterialChange(pack(), { items: [item("a")] }), true);
    assert.equal(isMaterialChange(pack(), { discount_percent: 20 }), true);
    assert.equal(isMaterialChange(pack(), { discount_enabled: false }), true);
    assert.equal(isMaterialChange(pack(), { free_delivery: false }), true);
  });
  it("ignores a percent change while the discount is off", () => {
    assert.equal(isMaterialChange(pack({ discount_enabled: false }), { discount_percent: 30 }), false);
  });
});

describe("resolvePackUpdate — no free delivery", () => {
  const plain = (over: Partial<PackReviewState> = {}) =>
    pack({ free_delivery: false, reviewed_at: null, ...over });

  it("applies the requested status and clears the review note", () => {
    assert.deepEqual(resolvePackUpdate(plain(), { status: "inactive" }), {
      status: "inactive",
      review_note: null,
      sent_to_review: false,
    });
    assert.deepEqual(resolvePackUpdate(plain({ status: "inactive" }), { status: "active" }), {
      status: "active",
      review_note: null,
      sent_to_review: false,
    });
  });

  it("keeps the current status when none is sent", () => {
    assert.equal(resolvePackUpdate(plain({ status: "inactive" }), { discount_percent: 5 }).status, "inactive");
  });

  it("puts a pack waiting in review live once free delivery is switched off", () => {
    const r = resolvePackUpdate(plain({ status: "under_review", free_delivery: true }), { free_delivery: false });
    assert.deepEqual(r, { status: "active", review_note: null, sent_to_review: false });
  });

  it("honours an explicit status for a pack that was in review", () => {
    const r = resolvePackUpdate(pack({ status: "under_review", reviewed_at: null }), {
      free_delivery: false,
      status: "inactive",
    });
    assert.equal(r.status, "inactive");
  });
});

describe("resolvePackUpdate — free delivery", () => {
  it("keeps an approved live pack live after a cosmetic edit", () => {
    assert.deepEqual(resolvePackUpdate(pack(), {}), { status: "active", sent_to_review: false });
    assert.deepEqual(resolvePackUpdate(pack(), { status: "active" }), { status: "active", sent_to_review: false });
  });

  it("sends a live pack back to review after a material edit", () => {
    assert.deepEqual(resolvePackUpdate(pack(), { items: [item("a", 3)] }), {
      status: "under_review",
      reviewed_at: null,
      review_note: null,
      sent_to_review: true,
    });
  });

  it("sends a pack to review when free delivery is switched on", () => {
    const r = resolvePackUpdate(pack({ free_delivery: false, reviewed_at: null }), { free_delivery: true });
    assert.equal(r.status, "under_review");
    assert.equal(r.sent_to_review, true);
  });

  it("re-reviews free delivery switched back on even if it was approved before", () => {
    const r = resolvePackUpdate(pack({ free_delivery: false }), { free_delivery: true, status: "active" });
    assert.equal(r.status, "under_review");
  });

  it("closes the under_review → inactive → active bypass", () => {
    const inReview = pack({ status: "under_review", reviewed_at: null });
    const off = resolvePackUpdate(inReview, { status: "inactive" });
    assert.equal(off.status, "inactive");
    const back = resolvePackUpdate({ ...inReview, status: off.status }, { status: "active" });
    assert.equal(back.status, "under_review");
    assert.equal(back.sent_to_review, true);
  });

  it("does not let a staff-rejected pack go live on its own", () => {
    const rejected = pack({ status: "inactive", reviewed_at: null, review_note: "Margin too low" });
    assert.equal(resolvePackUpdate(rejected, { status: "active" }).status, "under_review");
  });

  it("keeps a pack in review in review when the merchant asks for active", () => {
    const r = resolvePackUpdate(pack({ status: "under_review", reviewed_at: null }), { status: "active" });
    assert.equal(r.status, "under_review");
  });

  it("re-activates an approved pack the merchant paused, without review", () => {
    const paused = pack({ status: "inactive" });
    assert.deepEqual(resolvePackUpdate(paused, { status: "active" }), { status: "active", sent_to_review: false });
  });

  it("pausing or archiving never needs review; a material edit voids the approval", () => {
    assert.deepEqual(resolvePackUpdate(pack(), { status: "inactive" }), { status: "inactive", sent_to_review: false });
    assert.deepEqual(resolvePackUpdate(pack(), { status: "archived", discount_percent: 30 }), {
      status: "archived",
      reviewed_at: null,
      sent_to_review: false,
    });
  });

  it("an edit to a paused pack keeps it paused", () => {
    const r = resolvePackUpdate(pack({ status: "inactive" }), { items: [item("z")] });
    assert.deepEqual(r, { status: "inactive", reviewed_at: null, sent_to_review: false });
  });
});

describe("resolvePackUpdate — staff hold", () => {
  // Staff rejected / deactivated it: inactive, reviewed_at cleared, note set.
  const held = (over: Partial<PackReviewState> = {}) =>
    pack({ status: "inactive", reviewed_at: null, review_note: "Blurry image", ...over });

  it("is a staff note, not a merchant pause", () => {
    assert.equal(onStaffHold(held()), true);
    assert.equal(onStaffHold(pack({ status: "inactive" })), false);
    assert.equal(onStaffHold(pack({ review_note: "  " })), false);
  });

  it("sends a held pack to review when the merchant turns it on, free delivery or not", () => {
    for (const free_delivery of [true, false]) {
      assert.deepEqual(resolvePackUpdate(held({ free_delivery }), { status: "active" }), {
        status: "under_review",
        reviewed_at: null,
        sent_to_review: true,
      });
    }
  });

  it("keeps the staff note through the resubmission (only staff approval clears it)", () => {
    const r = resolvePackUpdate(held({ free_delivery: false }), { status: "active" });
    assert.equal("review_note" in r, false);
  });

  it("closes the resubmit → cancel → reactivate bypass", () => {
    const resubmitted = held({ free_delivery: false, status: "under_review" });
    const cancelled = resolvePackUpdate(resubmitted, { status: "inactive" });
    assert.deepEqual(cancelled, { status: "inactive", sent_to_review: false });
    const again = resolvePackUpdate({ ...resubmitted, status: cancelled.status }, { status: "active" });
    assert.equal(again.status, "under_review");
  });

  it("keeps a resubmitted non-free-delivery pack in review on an edit or a second toggle", () => {
    const resubmitted = held({ free_delivery: false, status: "under_review" });
    assert.equal(resolvePackUpdate(resubmitted, { discount_percent: 5 }).status, "under_review");
    assert.equal(resolvePackUpdate(resubmitted, { status: "active" }).status, "under_review");
  });

  it("goes through review even when free delivery is switched off", () => {
    const r = resolvePackUpdate(held(), { free_delivery: false, status: "active" });
    assert.equal(r.status, "under_review");
  });

  it("can be edited, paused or archived without clearing the hold", () => {
    assert.deepEqual(resolvePackUpdate(held({ free_delivery: false }), { discount_percent: 5 }), {
      status: "inactive",
      sent_to_review: false,
    });
    assert.deepEqual(resolvePackUpdate(held(), { status: "archived" }), { status: "archived", sent_to_review: false });
    const unarchived = resolvePackUpdate(held({ status: "archived", free_delivery: false }), { status: "active" });
    assert.equal(unarchived.status, "under_review");
  });

  it("still lets the merchant toggle their own paused pack", () => {
    const paused = pack({ free_delivery: false, reviewed_at: null, status: "inactive" });
    assert.equal(resolvePackUpdate(paused, { status: "active" }).status, "active");
  });
});

describe("changedColumns", () => {
  it("drops values already in place", () => {
    const current = { status: "inactive", reviewed_at: null, review_note: "x" };
    assert.deepEqual(changedColumns(current, { status: "inactive", reviewed_at: null }), {});
    assert.deepEqual(changedColumns(current, { status: "under_review", reviewed_at: null }), { status: "under_review" });
    assert.deepEqual(changedColumns({ status: "active" }, { status: "active", review_note: null }), {});
  });
});

describe("resolveStaffPackReview", () => {
  const NOW = "2026-10-10T12:00:00.000Z";
  const UPDATED = "2026-10-10T11:00:00.654321+00:00";
  const at = (status: PackReviewState["status"]) => ({ status, updated_at: UPDATED });

  it("approves a pack in review: stamps reviewed_at, clears the note", () => {
    assert.deepEqual(resolveStaffPackReview(at("under_review"), { status: "active" }, NOW), {
      ok: true,
      columns: { status: "active", reviewed_at: NOW, review_note: null },
    });
  });

  it("rejects a pack in review or deactivates a live one, with the note", () => {
    for (const status of ["under_review", "active"] as const) {
      assert.deepEqual(resolveStaffPackReview(at(status), { status: "inactive", note: " No margin " }, NOW), {
        ok: true,
        columns: { status: "inactive", reviewed_at: null, review_note: "No margin" },
      });
    }
  });

  it("needs a note to reject or deactivate", () => {
    for (const note of [undefined, "", "  "]) {
      const r = resolveStaffPackReview(at("active"), { status: "inactive", note }, NOW);
      assert.ok(!r.ok && r.status === 400 && r.code === "note_required");
    }
  });

  it("refuses decisions that don't fit the pack's status", () => {
    for (const status of ["active", "inactive", "archived"] as const) {
      const r = resolveStaffPackReview(at(status), { status: "active" }, NOW);
      assert.ok(!r.ok && r.status === 409 && r.code === "invalid_state", `approve ${status}`);
    }
    for (const status of ["inactive", "archived"] as const) {
      const r = resolveStaffPackReview(at(status), { status: "inactive", note: "x" }, NOW);
      assert.ok(!r.ok && r.status === 409 && r.code === "invalid_state", `deactivate ${status}`);
    }
  });

  it("refuses a decision on a pack that changed since the reviewer saw it", () => {
    const stale = resolveStaffPackReview(at("under_review"), { status: "active", expected_updated_at: "2026-10-10T10:00:00Z" }, NOW);
    assert.ok(!stale.ok && stale.status === 409 && stale.code === "stale");
    const same = resolveStaffPackReview(at("under_review"), { status: "active", expected_updated_at: "2026-10-10T11:00:00.654Z" }, NOW);
    assert.ok(same.ok);
  });
});

describe("newPackStatus", () => {
  it("reviews free delivery, publishes the rest", () => {
    assert.equal(newPackStatus(true), "under_review");
    assert.equal(newPackStatus(false), "active");
    assert.equal(newPackStatus(undefined), "active");
  });
});
