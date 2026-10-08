import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { MerchantStoreListResponse } from "../../validators/merchant";
import { normalizeStore, ownedStores, storeSalesStats } from "./shared";

const app = router();

// ─── Merchant: list own stores (with lifetime sales) ─────────────────
const route = createRoute({
  method: "get",
  path: "/stores",
  operationId: "listMerchantStores",
  tags: ["merchant"],
  security: bearer,
  responses: {
    200: json(MerchantStoreListResponse),
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const stores = await ownedStores(user.id);
  const stats = await storeSalesStats(stores.map((s) => s.id));

  return c.json(
    {
      stores: stores.map((s) => ({ ...normalizeStore(s), ...stats.get(s.id)! })) as any,
    },
    200
  );
});

export default app;
