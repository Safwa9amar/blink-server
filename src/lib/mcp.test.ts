import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { generateMcpToken, hashMcpToken, looksLikeMcpToken, mcpTokenPrefix } from "./mcp-token";
import { clampLimit, clampOffset, dateRange, maskRib, omitKeys, RateLimiter, sanitizeSearch, truncateArgs } from "./mcp-util";
import { toolAllowed, toolsForRole, type McpContext, type StaffRole } from "../mcp/registry";
import { ALL_TOOLS } from "../mcp/tools";
import { buildMcpServer } from "../mcp/server";

test("token: format, hash, prefix", () => {
  const t = generateMcpToken();
  assert.ok(t.startsWith("blk_mcp_"));
  assert.ok(looksLikeMcpToken(t));
  assert.equal(mcpTokenPrefix(t).length, 12);
  assert.match(hashMcpToken(t), /^[0-9a-f]{64}$/);
  assert.equal(hashMcpToken(t), hashMcpToken(t));
  assert.notEqual(hashMcpToken(t), hashMcpToken(generateMcpToken()));
  // known vector: sha256("abc")
  assert.equal(hashMcpToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(!looksLikeMcpToken("blk_mcp_short"));
});

test("clampLimit / clampOffset", () => {
  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit(0), 1);
  assert.equal(clampLimit(-5), 1);
  assert.equal(clampLimit(500), 50);
  assert.equal(clampLimit(7.9), 7);
  assert.equal(clampLimit("x"), 20);
  assert.equal(clampOffset(-3), 0);
  assert.equal(clampOffset(40), 40);
  assert.equal(clampOffset(undefined), 0);
});

test("maskRib keeps only the last 4", () => {
  assert.equal(maskRib(null), null);
  assert.equal(maskRib("00799999 0012345678 90 12"), "•••• 9012");
  assert.equal(maskRib("12"), "••••");
  assert.ok(!String(maskRib("0079999900123456789012")).includes("0079999900"));
});

test("truncateArgs shortens strings, arrays, depth", () => {
  const out = truncateArgs({ q: "x".repeat(500), ids: Array.from({ length: 30 }, (_, i) => i), n: 3 }) as any;
  assert.ok(out.q.length < 260 && out.q.includes("[+300]"));
  assert.equal(out.ids.length, 21);
  assert.equal(out.n, 3);
});

test("omitKeys / sanitizeSearch / dateRange", () => {
  assert.deepEqual(omitKeys({ a: 1, phone: "x", n: { recipient_phone: "y", ok: 2 }, l: [{ phone: 1, z: 3 }] }, /phone/i), {
    a: 1,
    n: { ok: 2 },
    l: [{ z: 3 }],
  });
  assert.equal(sanitizeSearch("a,b)(c%*"), "a b c");
  const r = dateRange("2026-10-19", "2026-10-19");
  assert.equal(r.gte, "2026-10-18T23:00:00.000Z");
  assert.equal(r.lt, "2026-10-19T23:00:00.000Z");
});

test("RateLimiter", () => {
  const l = new RateLimiter(3, 1000);
  assert.ok(l.take("a", 0) && l.take("a", 1) && l.take("a", 2));
  assert.ok(!l.take("a", 3));
  assert.ok(l.take("b", 3));
  assert.ok(l.take("a", 2000));
});

const names = (role: StaffRole) => toolsForRole(ALL_TOOLS, role).map((t) => t.name);

test("registry: role filtering", () => {
  assert.equal(names("super_admin").length, ALL_TOOLS.length);
  assert.ok(new Set(ALL_TOOLS.map((t) => t.name)).size === ALL_TOOLS.length, "unique names");
  assert.ok(names("hr_admin").includes("find_users"));
  assert.ok(names("hr_admin").includes("server_info"));
  assert.ok(!names("hr_admin").includes("get_wallet"));
  assert.ok(!names("support_admin").includes("list_transactions"));
  assert.ok(names("support_admin").includes("get_support_conversation"));
  assert.ok(names("finance_admin").includes("get_wallet"));
  assert.ok(!names("finance_admin").includes("get_support_conversation"));
  assert.ok(names("commerce_admin").includes("list_stores"));
  assert.ok(!names("commerce_admin").includes("get_wallet"));
  assert.ok(toolAllowed({ roles: ["ops_admin"] }, "super_admin"));
  assert.ok(!toolAllowed({ roles: ["ops_admin"] }, "hr_admin"));
});

function ctx(role: StaffRole): McpContext {
  return { tokenId: null, user: { id: "00000000-0000-0000-0000-000000000000", first_name: "T", last_name: "T", staff_role: role }, staffRole: role };
}

async function connect(role: StaffRole) {
  const server = buildMcpServer(ctx(role));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("MCP handshake: tools/list is role-filtered, tools are read-only", async () => {
  const sa = await connect("super_admin");
  const all = await sa.listTools();
  assert.equal(all.tools.length, ALL_TOOLS.length);
  assert.ok(all.tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.match(sa.getInstructions() ?? "", /READ-ONLY/);
  await sa.close();

  const hr = await connect("hr_admin");
  const hrTools = (await hr.listTools()).tools.map((t) => t.name);
  assert.deepEqual(hrTools.sort(), names("hr_admin").sort());
  assert.ok(!hrTools.includes("list_transactions"));
  // Calling an unregistered tool fails.
  const res = await hr.callTool({ name: "list_transactions", arguments: {} }).catch((e) => ({ isError: true, e }));
  assert.ok((res as any).isError);
  await hr.close();
});

test("tool input validation rejects bad args", async () => {
  const c = await connect("super_admin");
  const res: any = await c.callTool({ name: "get_user", arguments: { user_id: "nope" } }).catch((e) => ({ isError: true, e }));
  assert.ok(res.isError);
  await c.close();
});

test("HTTP transport (stateless): initialize, list, call over real Streamable HTTP", async () => {
  const { Hono } = await import("hono");
  const { serve } = await import("@hono/node-server");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { handleMcp } = await import("../mcp/route");
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("mcp", ctx("hr_admin"));
    await next();
  });
  app.all("/mcp", handleMcp as any);
  const srv = serve({ fetch: app.fetch, port: 0 });
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  try {
    // Two independent clients = two independent stateless requests sets.
    for (let i = 0; i < 2; i++) {
      const client = new Client({ name: "http-test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, names("hr_admin").sort());
      const info: any = await client.callTool({ name: "server_info", arguments: {} });
      assert.ok(!info.isError || typeof info.content[0].text === "string");
      await client.close();
    }
  } finally {
    srv.close();
  }
});
