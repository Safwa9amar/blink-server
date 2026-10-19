import { supabaseAdmin } from "../lib/supabase";
import { truncateArgs } from "../lib/mcp-util";
import type { McpContext } from "./registry";

let warned = false;

/** Fire-and-forget: an audit failure must never fail (or delay) the tool call. */
export function auditToolCall(
  ctx: McpContext,
  e: { tool: string; args: unknown; ok: boolean; error?: string; rowCount?: number; durationMs: number; source?: "mcp" | "assistant" }
): void {
  void (async () => {
    try {
      const { error } = await supabaseAdmin.from("staff_mcp_audit").insert({
        token_id: ctx.tokenId,
        user_id: ctx.user.id,
        tool: e.tool,
        args: truncateArgs(e.args) as Record<string, unknown>,
        ok: e.ok,
        error: e.error ? e.error.slice(0, 500) : null,
        row_count: e.rowCount ?? null,
        duration_ms: Math.round(e.durationMs),
        ...(e.source && e.source !== "mcp" ? { source: e.source } : {}),
      });
      if (error && !warned) {
        warned = true;
        console.warn("[mcp] audit insert failed:", error.message);
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn("[mcp] audit insert threw:", (err as Error).message);
      }
    }
  })();
}
