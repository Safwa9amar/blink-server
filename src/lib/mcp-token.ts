import { createHash, randomBytes } from "node:crypto";

/**
 * Staff MCP personal access tokens.
 *
 * Format:   "blk_mcp_" + base64url(32 random bytes)
 * Stored:   token_hash   = sha256(<full token>) as lowercase hex
 *           token_prefix = first 12 chars of the token (display only)
 * The dashboard mints tokens and writes rows with this exact hashing; the
 * server only ever looks a presented token up by its hash.
 */
export const MCP_TOKEN_PREFIX = "blk_mcp_";

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function looksLikeMcpToken(token: string): boolean {
  return /^blk_mcp_[A-Za-z0-9_-]{43}$/.test(token);
}

export function mcpTokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** Mint a new token (used by tests; the dashboard has its own copy of this). */
export function generateMcpToken(): string {
  return MCP_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}
