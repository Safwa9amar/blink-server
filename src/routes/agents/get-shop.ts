import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentShopResponse } from "../../validators/agents";
import { primaryShop } from "./shared";

const app = router();

// ─── Agent: get primary shop ─────────────────────────────────────────
// The shop riders see first; the full multi-shop list is GET /shops.
const route = createRoute({
  method: "get",
  path: "/shop",
  operationId: "getAgentShop",
  tags: ["agents"],
  security: bearer,
  responses: {
    200: json(AgentShopResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const shop = await primaryShop(user.id);
  if (!shop) return c.json({ error: "Shop not found" }, 404);
  return c.json({ shop: { ...shop, documents: shop.documents ?? {} } }, 200);
});

export default app;
