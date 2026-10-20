import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForRole, type StaffRole } from "../mcp/registry";
import { ALL_TOOLS } from "../mcp/tools";
import {
  algiersHour, bucketByDay, dayKeys, demandStats, FIELD_OPS_TOOLS, median, metricsTimeseries,
  minutesBetween, minutesSince, resolveRange, topPerformers,
} from "../mcp/tools/field-ops";

const ctx = { tokenId: null, user: { id: "u", first_name: null, last_name: null, staff_role: "super_admin" as StaffRole }, staffRole: "super_admin" as StaffRole };
const names = (role: StaffRole) => toolsForRole(FIELD_OPS_TOOLS, role).map((t) => t.name);

test("fieldops: roles", () => {
  assert.equal(FIELD_OPS_TOOLS.length, 8);
  assert.deepEqual(names("finance_admin"), []);
  assert.deepEqual(names("hr_admin").sort(), ["list_agents", "list_riders", "rider_verification_queue"]);
  assert.ok(names("support_admin").includes("live_ops_snapshot"));
  assert.equal(names("super_admin").length, 8);
  assert.equal(names("ops_admin").length, 8);
  assert.equal(ALL_TOOLS.filter((t) => FIELD_OPS_TOOLS.includes(t)).length, 8);
  for (const t of FIELD_OPS_TOOLS) assert.ok(t.description.length <= 300, `${t.name} description ${t.description.length}`);
});

test("fieldops: range validation", async () => {
  assert.throws(() => resolveRange("2026-01-01", "2026-06-01"), /too large/);
  assert.throws(() => resolveRange("2026-10-10", "2026-10-01"), /on or before/);
  const r = resolveRange("2026-10-01", "2026-10-07");
  assert.equal(r.days, 7);
  assert.equal(r.gte, "2026-09-30T23:00:00.000Z");
  assert.equal(r.lt, "2026-10-07T23:00:00.000Z");
  assert.equal(resolveRange("2026-01-01", "2026-04-02").days, 92);
  assert.throws(() => resolveRange("2026-01-01", "2026-04-03"), /too large/);
  const d = resolveRange(undefined, undefined, 7, new Date("2026-10-20T10:00:00Z"));
  assert.equal(d.from, "2026-10-14");
  assert.equal(d.to, "2026-10-20");
  await assert.rejects(metricsTimeseries.handler({ created_from: "2025-01-01", created_to: "2026-01-01" }, ctx), /too large/);
  await assert.rejects(topPerformers.handler({ created_from: "2025-01-01" }, ctx), /too large/);
});

test("fieldops: bucketing and time math", () => {
  assert.deepEqual(dayKeys("2026-10-01", "2026-10-03"), ["2026-10-01", "2026-10-02", "2026-10-03"]);
  const rows = [
    { t: "2026-10-01T22:30:00Z", a: 10 }, // Algiers Oct 1 23:30
    { t: "2026-10-01T23:30:00Z", a: 5 }, // Algiers Oct 2 00:30
    { t: "2026-10-09T00:00:00Z", a: 1 }, // outside
  ];
  const b = bucketByDay(rows, dayKeys("2026-10-01", "2026-10-03"), (r) => r.t, (r) => r.a);
  assert.deepEqual(b.map((x) => [x.count, x.amount]), [[1, 10], [1, 5], [0, 0]]);
  assert.equal(algiersHour("2026-10-01T23:30:00Z"), 0);
  assert.equal(minutesBetween("2026-10-01T10:00:00Z", "2026-10-01T10:07:30Z"), 7.5);
  assert.equal(minutesBetween("2026-10-01T10:10:00Z", "2026-10-01T10:00:00Z"), null);
  assert.equal(minutesSince("2026-10-01T10:00:00Z", new Date("2026-10-01T10:15:59Z")), 15);
  assert.equal(minutesSince(null), null);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test("fieldops: demandStats", () => {
  const s = demandStats([
    { created_at: "2026-10-01T09:00:00Z", type: "ride", status: "delivered", rider_id: "r", rider_assigned_at: "2026-10-01T09:04:00Z", cancel_reason: null },
    { created_at: "2026-10-01T09:10:00Z", type: "ride", status: "canceled", rider_id: null, rider_assigned_at: null, cancel_reason: "no_rider" },
    { created_at: "2026-10-01T10:10:00Z", type: "courier", status: "canceled", rider_id: null, rider_assigned_at: null, cancel_reason: "changed_mind" },
  ]);
  assert.equal(s.byHour[10].orders, 2);
  assert.equal(s.byHour[11].orders, 1);
  assert.deepEqual(s.unmet, { canceled_reason_no_rider: 1, canceled_without_rider: 2 });
  assert.equal(s.assignment.avg, 4);
});
