import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentShopResponse } from "../../validators/agents";

const app = router();

// ─── Agent: get own shop ─────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/shop",
  operationId: "getAgentShop",
  tags: ["agents"],
  security: bearer,
  middleware: [auth, requireRole("agent")] as const,
  responses: {
    200: json(AgentShopResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return c.json({ error: "Shop not found" }, 404);
  }

  return c.json({ shop: data }, 200);
});

export default app;
