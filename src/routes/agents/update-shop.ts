import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentShopResponse, updateShopSchema } from "../../validators/agents";

const app = router();

// ─── Agent: update shop ──────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/shop",
  operationId: "updateAgentShop",
  tags: ["agents"],
  security: bearer,
  middleware: [auth, requireRole("agent")] as const,
  request: { body: { ...json(updateShopSchema), required: true } },
  responses: {
    200: json(AgentShopResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .update(body)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Shop not found" }, 404);
  }

  return c.json({ shop: data }, 200);
});

export default app;
