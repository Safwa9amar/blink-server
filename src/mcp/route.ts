import { Hono, type Context } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { mcpAuth, type McpEnv } from "./auth";
import { buildMcpServer } from "./server";

/**
 * Serve one MCP request — Streamable HTTP, STATELESS: a fresh McpServer +
 * transport per request (requests may land on either Render instance, so there
 * is no session state). Expects c.var.mcp to be set by the auth middleware.
 */
export async function handleMcp(c: Context<McpEnv>): Promise<Response> {
  const server = buildMcpServer(c.get("mcp"));
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return (await transport.handleRequest(c)) ?? c.body(null, 204);
  } finally {
    void server.close().catch(() => undefined);
  }
}

const mcp = new Hono<McpEnv>();
mcp.use("*", mcpAuth);
mcp.all("/", handleMcp);

export default mcp;
