import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, OkSchema, router } from "../../openapi";
import { ownedPack } from "./shared";

const app = router();

// ─── Merchant: delete a pack ─────────────────────────────────────────
const route = createRoute({
  method: "delete",
  path: "/packs/{id}",
  operationId: "deleteMerchantPack",
  tags: ["merchant"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(OkSchema),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  if (!(await ownedPack(user.id, id))) return c.json({ error: "Pack not found" }, 404);

  const { error } = await supabaseAdmin.from("store_packs").delete().eq("id", id);
  if (error) return c.json({ error: error.message }, 404);
  return c.json({ success: true }, 200);
});

export default app;
