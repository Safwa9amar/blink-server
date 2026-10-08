import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentShopResponse, updateShopSchema } from "../../validators/agents";
import { primaryShop, updateShop } from "./shared";

const app = router();

// ─── Agent: update primary shop ──────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/shop",
  operationId: "updateAgentShop",
  tags: ["agents"],
  security: bearer,
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

  const current = await primaryShop(user.id);
  if (!current) return c.json({ error: "Shop not found" }, 404);

  try {
    const shop = await updateShop(user.id, current.id, body);
    if (!shop) return c.json({ error: "Shop not found" }, 404);
    return c.json({ shop: { ...shop, documents: shop.documents ?? {} } }, 200);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
