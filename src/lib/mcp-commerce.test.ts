import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForRole, type StaffRole } from "../mcp/registry";
import { ALL_TOOLS } from "../mcp/tools";
import { COMMERCE_TOOLS, packState, pendingDocKeys, statusOfOverride } from "../mcp/tools/commerce";
import { z } from "zod";

const names = (role: StaffRole) => toolsForRole(COMMERCE_TOOLS, role).map((t) => t.name);
const PRICING = ["list_price_changes", "get_pricing_config", "simulate_price"];

test("commerce tools: registered, unique, short descriptions", () => {
  for (const t of COMMERCE_TOOLS) {
    assert.ok(ALL_TOOLS.includes(t), t.name);
    assert.ok(t.description.length <= 300, `${t.name} description ${t.description.length}`);
  }
  assert.equal(new Set(ALL_TOOLS.map((t) => t.name)).size, ALL_TOOLS.length);
});

test("commerce tools: role filtering", () => {
  assert.equal(names("super_admin").length, COMMERCE_TOOLS.length);
  assert.equal(names("commerce_admin").length, COMMERCE_TOOLS.length);
  assert.equal(names("ops_admin").length, COMMERCE_TOOLS.length);
  assert.equal(names("hr_admin").length, 0);
  assert.equal(names("support_admin").length, 0);
  assert.deepEqual(names("finance_admin").sort(), [...PRICING].sort());
});

const shape = (n: string) => z.object(COMMERCE_TOOLS.find((t) => t.name === n)!.input as z.ZodRawShape);

test("commerce tools: input validation", () => {
  assert.ok(!shape("list_store_products").safeParse({ store_id: "nope" }).success);
  assert.ok(!shape("list_store_products").safeParse({ review_status: "x" }).success);
  assert.ok(!shape("list_packs").safeParse({ status: "active" }).success);
  assert.ok(shape("list_packs").safeParse({ status: "held" }).success);
  assert.ok(!shape("simulate_price").safeParse({}).success);
  assert.ok(!shape("simulate_price").safeParse({ scenario: "ride", km: 9999 }).success);
  assert.ok(!shape("simulate_price").safeParse({ scenario: "deposit", amount: -1 }).success);
  assert.ok(shape("simulate_price").safeParse({ scenario: "courier", km: 4, vehicle: "bicycle" }).success);
  assert.ok(!shape("get_pricing_config").safeParse({ key: "bogus" }).success);
  assert.ok(!shape("list_price_changes").safeParse({ created_from: "yesterday" }).success);
  assert.ok(!shape("list_coupons").safeParse({ status: "live" }).success);
  assert.ok(!shape("list_promotions").safeParse({ status: "active" }).success);
});

test("packState", () => {
  assert.equal(packState({ status: "under_review", review_note: null }), "review");
  assert.equal(packState({ status: "active", review_note: null }), "live");
  assert.equal(packState({ status: "inactive", review_note: "bad" }), "held");
  assert.equal(packState({ status: "inactive", review_note: " " }), "paused");
});

test("statusOfOverride / pendingDocKeys", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(statusOfOverride({ starts_at: null, ends_at: null }, now), "active");
  assert.equal(statusOfOverride({ starts_at: "2026-11-01T00:00:00Z", ends_at: null }, now), "scheduled");
  assert.equal(statusOfOverride({ starts_at: null, ends_at: "2026-10-01T00:00:00Z" }, now), "ended");
  assert.deepEqual(pendingDocKeys({}, {}), []);
  assert.deepEqual(pendingDocKeys({ nif: "https://x/y.png" }, {}), ["nif"]);
});
