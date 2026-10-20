import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { toolsForRole, type McpContext, type StaffRole } from "../mcp/registry";
import { buildMcpServer } from "../mcp/server";
import { ALL_TOOLS } from "../mcp/tools";
import { FINANCE_TOOLS, maskPayout, tally } from "../mcp/tools/finance";

const ctx = (role: StaffRole): McpContext => ({
  tokenId: null,
  user: { id: "00000000-0000-0000-0000-000000000000", first_name: "T", last_name: "T", staff_role: role },
  staffRole: role,
});
async function connect(role: StaffRole) {
  const server = buildMcpServer(ctx(role));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const fin = FINANCE_TOOLS.map((t) => t.name);

test("finance tools: 8, unique, terse descriptions, roles set", () => {
  assert.equal(FINANCE_TOOLS.length, 8);
  assert.equal(new Set(ALL_TOOLS.map((t) => t.name)).size, ALL_TOOLS.length);
  for (const t of FINANCE_TOOLS) {
    assert.ok(t.description.length <= 300, `${t.name} description ${t.description.length}`);
    assert.ok(t.roles && t.roles.length > 0, t.name);
  }
});

test("finance tools: role filtering", () => {
  const vis = (r: StaffRole) => toolsForRole(FINANCE_TOOLS, r).map((t) => t.name);
  assert.deepEqual(vis("finance_admin").sort(), [...fin].sort());
  assert.deepEqual(vis("super_admin").sort(), [...fin].sort());
  assert.ok(!vis("ops_admin").includes("list_finance_audit"));
  assert.equal(vis("ops_admin").length, 7);
  assert.equal(vis("support_admin").length, 0);
  assert.equal(vis("hr_admin").length, 0);
});

test("finance tools: bad args rejected", async () => {
  const c = await connect("super_admin");
  const bad: [string, Record<string, unknown>][] = [
    ["get_wallet_ledger", {}],
    ["get_wallet_ledger", { user_id: "nope" }],
    ["get_wallet_ledger", { user_id: "00000000-0000-0000-0000-000000000000", kind: "x" }],
    ["get_agent_dues", { agent_id: "x" }],
    ["list_dues_payments", {}],
    ["list_dues_payments", { party: "rider" }],
    ["list_cash_reviews", { type: "refund" }],
    ["list_finance_audit", { actor_id: "x" }],
    ["cash_flow_summary", { created_from: "yesterday" }],
  ];
  for (const [name, args] of bad) {
    const res: any = await c.callTool({ name, arguments: args }).catch((e) => ({ isError: true, e }));
    assert.ok(res.isError, `${name} ${JSON.stringify(args)} should fail`);
  }
  await c.close();
});

test("finance helpers: masking and tally", () => {
  assert.equal(maskPayout(null), null);
  const m = maskPayout({ type: "ccp", number: "0079999900123456", holder: "A" })!;
  assert.equal(m.number, "•••• 3456");
  assert.ok(!JSON.stringify(m).includes("00799999"));
  assert.deepEqual(
    tally([{ k: "a", v: 1.1 }, { k: "a", v: 2.2 }, { k: "b", v: 5 }], (r) => r.k, (r) => r.v),
    { a: { count: 2, amount: 3.3 }, b: { count: 1, amount: 5 } }
  );
});
