import assert from "node:assert/strict";
import { test } from "node:test";
import { toolsForRole, type McpContext, type StaffRole } from "../mcp/registry";
import { ALL_TOOLS } from "../mcp/tools";
import { PLATFORM_TOOLS, isStaffNotificationUnread, myStaffNotifications } from "../mcp/tools/platform";
import { supabaseAdmin } from "./supabase";
import { z } from "zod";

const names = (role: StaffRole) => toolsForRole(ALL_TOOLS, role).map((t) => t.name);
const parse = (name: string, args: unknown) => {
  const t = PLATFORM_TOOLS.find((x) => x.name === name)!;
  return z.object(t.input as z.ZodRawShape).safeParse(args);
};

test("platform tools: registered, unique, short descriptions", () => {
  assert.equal(PLATFORM_TOOLS.length, 9);
  for (const t of PLATFORM_TOOLS) {
    assert.ok(t.description.length <= 300, `${t.name} description ${t.description.length}`);
    assert.ok(ALL_TOOLS.includes(t as never));
  }
});

test("platform tools: role filtering", () => {
  const fin = names("finance_admin");
  assert.ok(fin.includes("search_help_center") && fin.includes("my_staff_notifications"));
  for (const n of ["kb_index_status", "support_desk_summary", "list_broadcasts", "list_account_deletion_requests", "referral_stats", "staff_activity_audit", "list_alerts"]) {
    assert.ok(!fin.includes(n), n);
  }
  for (const role of ["support_admin", "ops_admin", "hr_admin", "commerce_admin", "finance_admin"] as StaffRole[]) {
    assert.ok(!names(role).includes("staff_activity_audit"), role);
  }
  assert.ok(names("super_admin").includes("staff_activity_audit"));
  assert.ok(names("ops_admin").includes("list_alerts") && !names("support_admin").includes("list_alerts"));
  assert.ok(names("hr_admin").includes("list_account_deletion_requests"));
  assert.ok(names("commerce_admin").includes("referral_stats"));
  assert.ok(names("support_admin").includes("kb_index_status"));
});

test("platform tools: input validation", () => {
  assert.ok(!parse("search_help_center", { query: "x" }).success);
  assert.ok(!parse("search_help_center", { query: "refund?", role: "admin" }).success);
  assert.ok(parse("search_help_center", { query: "refund?", role: "rider", locale: "fr" }).success);
  assert.ok(!parse("list_broadcasts", {}).success);
  assert.ok(!parse("staff_activity_audit", { staff_user_id: "nope" }).success);
  assert.ok(!parse("referral_stats", { created_from: "yesterday" }).success);
  assert.ok(parse("list_alerts", { status: "active" }).success);
});

test("unread rule", () => {
  const now = Date.parse("2026-10-20T12:00:00Z");
  assert.equal(isStaffNotificationUnread("2026-10-20T10:00:00Z", "2026-10-20T11:00:00Z", null, now), false);
  assert.equal(isStaffNotificationUnread("2026-10-20T10:00:00Z", null, null, now), true);
  assert.equal(isStaffNotificationUnread("2026-10-01T10:00:00Z", null, null, now), false); // older than 7d, no watermark
  assert.equal(isStaffNotificationUnread("2026-10-20T10:00:00Z", null, "2026-10-20T11:00:00Z", now), false);
});

test("my_staff_notifications is scoped to ctx.user.id and takes no user input", async () => {
  assert.deepEqual(Object.keys(myStaffNotifications.input).sort(), ["limit", "offset", "unread_only"]);
  const seen: Record<string, string[]> = {};
  const orig = (supabaseAdmin as any).from;
  (supabaseAdmin as any).from = (table: string) => {
    const b: any = {
      select: () => b,
      order: () => b,
      in: (col: string, vs: string[]) => ((seen[`${table}.in`] ??= []).push(`${col}:${vs.length}`), b),
      limit: () => Promise.resolve({ data: [], error: null }),
      eq: (col: string, v: string) => {
        (seen[table] ??= []).push(`${col}=${v}`);
        return table === "staff_notification_state" ? { maybeSingle: () => Promise.resolve({ data: null, error: null }) } : Promise.resolve({ data: [], error: null });
      },
    };
    return b;
  };
  try {
    const ctx: McpContext = { tokenId: null, user: { id: "11111111-1111-1111-1111-111111111111", first_name: "A", last_name: "B", staff_role: "finance_admin" }, staffRole: "finance_admin" };
    await myStaffNotifications.handler({ user_id: "99999999-9999-9999-9999-999999999999" } as never, ctx);
    assert.deepEqual(seen.staff_notification_reads, ["user_id=11111111-1111-1111-1111-111111111111"]);
    assert.deepEqual(seen.staff_notification_state, ["user_id=11111111-1111-1111-1111-111111111111"]);
    // finance_admin: the feed is narrowed to the kinds the role sees in the dashboard.
    assert.equal(seen["staff_notifications.in"]?.length, 1);
    assert.match(seen["staff_notifications.in"][0], /^kind:\d+$/);
  } finally {
    (supabaseAdmin as any).from = orig;
  }
});

test("my_staff_notifications: each role only gets the inbox kinds it sees in the dashboard", async () => {
  const { inboxKindsFor } = await import("../mcp/tools/platform");
  assert.equal(inboxKindsFor("super_admin"), null);
  const finance = inboxKindsFor("finance_admin")!;
  assert.ok(finance.includes("dues.paid"));
  assert.ok(!finance.includes("user.signup") && !finance.includes("support.waiting"));
  const hr = inboxKindsFor("hr_admin")!;
  assert.ok(hr.includes("rider.documents") && !hr.includes("dues.paid"));
  for (const r of ["ops_admin", "finance_admin", "support_admin", "commerce_admin", "hr_admin"] as const) {
    assert.ok(!inboxKindsFor(r)!.includes("alert.fired"), `${r} must not see alert.fired`);
  }
});
