import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RateLimiter } from "../lib/mcp-util";
import { auditToolCall } from "./audit";
import { toolAllowed, toolsForRole, type McpContext, type ToolDef } from "./registry";
import { ALL_TOOLS } from "./tools";
import { VERSION } from "./version";

export const MCP_INSTRUCTIONS = `Blink is an Algerian delivery super-app (all money is in Algerian dinars, DZD; timezone Africa/Algiers). \
App users have a role: customer, rider, merchant or agent (agents run Blink Cash deposit/withdraw shops); staff have a separate staff_role. \
Orders cover merchant store deliveries, shopper, courier parcels and rides; riders get a trip per accepted job.

These tools are READ-ONLY and curated; every call is audited and limited to your staff role. \
Start with find_users (name, phone, email or BK-xx-###### id) to get uuids, then use the detail tools (get_user, list_orders, get_order, get_wallet, ...). \
Lists return newest first with limit (max 50) and offset/next_offset paging. Use ops_summary for counts instead of paging through lists.`;

const MAX_CALLS_PER_MIN = 120;
const limiter = new RateLimiter(MAX_CALLS_PER_MIN, 60_000);

function text(obj: unknown, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj) }], ...(isError ? { isError: true } : {}) };
}

/** Build an McpServer exposing only the tools `ctx.staffRole` may use. */
export function buildMcpServer(ctx: McpContext, tools: readonly ToolDef<any>[] = ALL_TOOLS): McpServer {
  const server = new McpServer({ name: "blink-staff", version: VERSION }, { instructions: MCP_INSTRUCTIONS });

  for (const tool of toolsForRole(tools, ctx.staffRole)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: `${tool.description}${tool.roles ? ` Available to: super_admin, ${tool.roles.join(", ")}.` : ""}`,
        inputSchema: tool.input,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const started = performance.now();
        const done = (ok: boolean, extra: { error?: string; rowCount?: number } = {}) =>
          auditToolCall(ctx, { tool: tool.name, args, ok, durationMs: performance.now() - started, ...extra });

        // Re-check (defence in depth — the tool is only registered when allowed).
        if (!toolAllowed(tool, ctx.staffRole)) {
          done(false, { error: "forbidden" });
          return text({ error: `Your staff role (${ctx.staffRole}) cannot use ${tool.name}.` }, true);
        }
        if (!limiter.take(ctx.tokenId ?? `user:${ctx.user.id}`)) {
          done(false, { error: "rate_limited" });
          return text({ error: `Rate limit: max ${MAX_CALLS_PER_MIN} tool calls per minute. Slow down and retry.` }, true);
        }
        try {
          const res = await tool.handler(args, ctx);
          done(true, { rowCount: res.rowCount });
          return { ...text(res.data), structuredContent: res.data };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          done(false, { error: message });
          return text({ error: message }, true);
        }
      }
    );
  }
  return server;
}
