import { loadVisiblePacks } from "../../lib/store-packs";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { CustomerPackListResponse } from "../../validators/marketplace";

const app = router();

// ─── List a store's packs, priced from live product prices ───────────
const route = createRoute({
  method: "get",
  path: "/stores/{id}/packs",
  operationId: "listStorePacks",
  tags: ["marketplace"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(CustomerPackListResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");

  const { data: store } = await supabaseAdmin
    .from("stores")
    .select("id")
    .eq("id", id)
    .eq("status", "active")
    .maybeSingle();
  if (!store) {
    return c.json({ error: "Store not found" }, 404);
  }

  // Active packs whose every product customers can see — the same loader
  // POST /orders checks pack lines with.
  try {
    const packs = await loadVisiblePacks(id);
    return c.json({ packs }, 200);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

export default app;
