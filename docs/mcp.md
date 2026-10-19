# Staff MCP server

A **read-only** [Model Context Protocol](https://modelcontextprotocol.io) endpoint for Blink ops/admin staff to use from AI clients (Claude Desktop, Claude Code, any MCP client). It is not used by the in-app support bot.

- Endpoint (Streamable HTTP, stateless): `https://blink-server-q4ey.onrender.com/mcp`
- Hot spare: `https://blink-server-spare.onrender.com/mcp`
- Code: `src/mcp/` (`route.ts` transport, `auth.ts`, `server.ts`, `registry.ts`, `tools/*`), pure helpers in `src/lib/mcp-token.ts` and `src/lib/mcp-util.ts`, tests in `src/lib/mcp.test.ts`.

## Getting a token

Create a personal token in the dashboard (staff area). It looks like `blk_mcp_<43 chars>` and is shown once. The server stores only `sha256(token)` hex (`staff_mcp_tokens.token_hash`) plus a 12-char display prefix. Tokens can expire and can be revoked.

## Connect

Claude Code:

```bash
claude mcp add --transport http blink https://blink-server-q4ey.onrender.com/mcp \
  --header "Authorization: Bearer blk_mcp_..."
```

Claude Desktop (`claude_desktop_config.json`, via the `mcp-remote` bridge):

```json
{
  "mcpServers": {
    "blink": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://blink-server-q4ey.onrender.com/mcp",
        "--header", "Authorization: Bearer blk_mcp_..."
      ]
    }
  }
}
```

## Tools

Money is DZD. Lists return `{ items, total, next_offset }`, newest first, `limit` default 20 / max 50, `offset` paging. `super_admin` sees everything; `tools/list` only contains the tools your role may use.

| Tool | Purpose | Roles (besides super_admin) |
| --- | --- | --- |
| `find_users` | Search by name / phone / email / uuid / `BK-xx-######` id, optional role | all staff |
| `get_user` | User + customer/rider/merchant/agent profile summaries, vehicle, stores, shops | all staff |
| `list_orders`, `get_order` | Orders (status, type, customer, rider, store, dates); detail has items, trip | ops, support, commerce, finance |
| `list_trips`, `get_trip` | Rider trips | ops, support, finance |
| `list_transactions`, `get_transaction` | Blink Cash deposits/withdrawals | finance, ops |
| `get_wallet` | Rider wallet, agent dues, merchant dues payments | finance, ops |
| `list_stores`, `get_store` | Merchant stores + review state | ops, commerce |
| `list_support_conversations`, `get_support_conversation` | Support desk (newest 100 messages) | support, ops |
| `ops_summary` | Counts for a date range (default today, Africa/Algiers) | ops, finance |
| `server_info` | Version, uptime, node, active AI provider (no keys) | all staff |

## Security model

- **Read-only, curated.** No writes, no raw SQL. Every query uses an explicit column allowlist.
- **Never returned:** PIN hashes, tokens/secrets, device tokens, AI provider keys, `staff_mcp_tokens.token_hash`, OTP data, QR pending references, document file URLs. Bank RIB is masked to the last 4 digits. Phone/email are only returned by the user-lookup tools (`find_users`, `get_user`); phone keys are stripped from order courier/ride JSON.
- **Auth:** `Authorization: Bearer blk_mcp_...` is hashed and matched to an unrevoked, unexpired `staff_mcp_tokens` row; the owner's `users.staff_role` is read on **every request**, so clearing someone's staff role cuts access immediately. A normal Supabase staff JWT is also accepted. Failures return `401` with a JSON-RPC error body.
- **Audit:** every tool call inserts one `staff_mcp_audit` row (tool, truncated args, ok/error, row count, duration), fire-and-forget. `last_used_at` is updated at most once a minute per token.
- **Rate limit:** 120 tool calls per minute per token (in-memory, per instance).
- **Revocation:** set `revoked_at` on the token (dashboard) or remove the owner's staff role.

Migration: `supabase/migrations/20261019210000_staff_mcp_tokens.sql` (apply with `npm run db:push`).
