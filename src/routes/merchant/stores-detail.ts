import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { MerchantStoreResponse } from "../../validators/merchant";
import { normalizeStore, ownedStore, storeSalesStats } from "./shared";

const app = router();

// ─── Merchant: one own store ─────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}",
  operationId: "getMerchantStore",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(MerchantStoreResponse),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const store = await ownedStore(user.id, id);
  if (!store) return c.json({ error: "Store not found" }, 404);

  const stats = await storeSalesStats([id]);
  return c.json({ store: { ...normalizeStore(store), ...stats.get(id)! } as any }, 200);
});

export default app;
