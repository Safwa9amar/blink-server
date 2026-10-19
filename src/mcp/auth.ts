import { createMiddleware } from "hono/factory";
import { supabaseAdmin } from "../lib/supabase";
import { hashMcpToken, looksLikeMcpToken, MCP_TOKEN_PREFIX } from "../lib/mcp-token";
import type { McpContext, StaffRole } from "./registry";

export type McpEnv = { Variables: { mcp: McpContext } };

const TOUCH_INTERVAL_MS = 60_000;
const lastTouched = new Map<string, number>();

function rpcError(c: { json: (b: unknown, s: 401 | 403 | 503, h?: Record<string, string>) => Response }, status: 401 | 403 | 503, message: string) {
  return c.json(
    { jsonrpc: "2.0", error: { code: -32001, message }, id: null },
    status,
    status === 401 ? { "WWW-Authenticate": 'Bearer realm="blink-mcp"' } : undefined
  );
}

type Loaded = { id: string; first_name: string | null; last_name: string | null; staff_role: StaffRole | null };

async function loadUser(id: string): Promise<Loaded | "error" | null> {
  const { data, error } = await supabaseAdmin
    .from("users")
    .select("id, first_name, last_name, staff_role")
    .eq("id", id)
    .maybeSingle();
  if (error) return "error";
  return (data as Loaded | null) ?? null;
}

/**
 * /mcp auth. Accepts a personal staff MCP token (Bearer blk_mcp_...) — looked up
 * by sha256 hash, must be unrevoked + unexpired and its owner must STILL have a
 * staff_role — or a normal Supabase staff JWT. Sets c.var.mcp.
 */
export const mcpAuth = createMiddleware<McpEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) return rpcError(c, 401, "Missing bearer token. Use a staff MCP token (blk_mcp_...) from the dashboard.");
  const token = header.slice(7).trim();

  let tokenId: string | null = null;
  let userId: string | null = null;

  if (token.startsWith(MCP_TOKEN_PREFIX)) {
    if (!looksLikeMcpToken(token)) return rpcError(c, 401, "Invalid token.");
    const { data, error } = await supabaseAdmin
      .from("staff_mcp_tokens")
      .select("id, user_id, expires_at, revoked_at")
      .eq("token_hash", hashMcpToken(token))
      .maybeSingle();
    if (error) return rpcError(c, 503, "Auth backend unavailable, retry.");
    const row = data as { id: string; user_id: string; expires_at: string | null; revoked_at: string | null } | null;
    if (!row || row.revoked_at || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) {
      return rpcError(c, 401, "Invalid, revoked or expired token.");
    }
    tokenId = row.id;
    userId = row.user_id;
  } else {
    // Supabase staff session JWT (e.g. the dashboard calling /mcp directly).
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) return rpcError(c, 401, "Invalid token.");
    userId = data.user.id;
  }

  const user = await loadUser(userId);
  if (user === "error") return rpcError(c, 503, "Auth backend unavailable, retry.");
  if (!user?.staff_role) return rpcError(c, 401, "This account no longer has staff access.");

  if (tokenId) {
    const now = Date.now();
    if (now - (lastTouched.get(tokenId) ?? 0) >= TOUCH_INTERVAL_MS) {
      lastTouched.set(tokenId, now);
      void supabaseAdmin
        .from("staff_mcp_tokens")
        .update({ last_used_at: new Date(now).toISOString() })
        .eq("id", tokenId)
        .then(() => undefined, () => undefined);
    }
  }

  c.set("mcp", {
    tokenId,
    user: { id: user.id, first_name: user.first_name, last_name: user.last_name, staff_role: user.staff_role },
    staffRole: user.staff_role,
  });
  await next();
});
