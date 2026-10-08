// Agent multi-shop management: list / create / detail / update the agent's
// kiosks. New shops start `under_review` (staff verify them) and closed; the
// first shop an agent creates becomes their primary.
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  AgentManagedShopResponse,
  AgentShopListResponse,
  createAgentShopSchema,
  updateShopSchema,
} from "../../validators/agents";
import { ownedShop, shopStats, toManagedShop, updateShop } from "./shared";

const app = router();

// ─── GET /shops ──────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/shops",
    operationId: "listAgentShops",
    tags: ["agents"],
    security: bearer,
    responses: {
      200: json(AgentShopListResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { data, error } = await supabaseAdmin
      .from("agent_shops")
      .select("*")
      .eq("user_id", user.id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true });
    if (error) return c.json({ error: error.message }, 400);
    const shops = data ?? [];
    const stats = await shopStats(shops.map((s) => s.id));
    return c.json({ shops: shops.map((s) => toManagedShop(s, stats)) }, 200);
  }
);

// ─── POST /shops ─────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/shops",
    operationId: "createAgentShop",
    tags: ["agents"],
    security: bearer,
    request: { body: { ...json(createAgentShopSchema), required: true } },
    responses: {
      201: json(AgentManagedShopResponse, "Created"),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // The signup flow leaves a blank placeholder shop; fill that one in
    // instead of stacking a second shop next to it.
    const { data: existing } = await supabaseAdmin
      .from("agent_shops")
      .select("id, shop_name, is_primary")
      .eq("user_id", user.id);
    const placeholder = (existing ?? []).find((s) => !s.shop_name?.trim());

    const fields = {
      ...body,
      shop_name: body.shop_name.trim(),
      status: "closed" as const,
      review_status: "under_review" as const,
    };

    const { data, error } = placeholder
      ? await supabaseAdmin
          .from("agent_shops")
          .update(fields)
          .eq("id", placeholder.id)
          .select()
          .single()
      : await supabaseAdmin
          .from("agent_shops")
          .insert({
            ...fields,
            user_id: user.id,
            is_primary: !(existing ?? []).some((s) => s.is_primary),
          })
          .select()
          .single();
    if (error || !data) return c.json({ error: error?.message ?? "Could not create shop" }, 400);

    const stats = await shopStats([data.id]);
    return c.json({ shop: toManagedShop(data, stats) }, 201);
  }
);

// ─── GET /shops/{id} ─────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/shops/{id}",
    operationId: "getAgentShopById",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(AgentManagedShopResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const shop = await ownedShop(user.id, id);
    if (!shop) return c.json({ error: "Shop not found" }, 404);
    const stats = await shopStats([shop.id]);
    return c.json({ shop: toManagedShop(shop, stats) }, 200);
  }
);

// ─── PATCH /shops/{id} ───────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/shops/{id}",
    operationId: "updateAgentShopById",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam, body: { ...json(updateShopSchema), required: true } },
    responses: {
      200: json(AgentManagedShopResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    try {
      const shop = await updateShop(user.id, id, body);
      if (!shop) return c.json({ error: "Shop not found" }, 404);
      const stats = await shopStats([shop.id]);
      return c.json({ shop: toManagedShop(shop, stats) }, 200);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  }
);

export default app;
