import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { StoreProductSchema, StoreSchema } from "../../validators/marketplace";
import { PackSchema, reviewProductSchema, reviewStoreSchema } from "../../validators/merchant";
import { z } from "@hono/zod-openapi";

const app = router();

// ─── Staff: approve / deactivate a merchant store ────────────────────
// Tagged admin-* so it stays out of the mobile client (orval skips it).
const storeRoute = createRoute({
  method: "patch",
  path: "/admin/stores/{id}/status",
  operationId: "reviewMerchantStore",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: { params: IdParam, body: { ...json(reviewStoreSchema), required: true } },
  responses: {
    200: json(z.object({ store: StoreSchema })),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(storeRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { status } = c.req.valid("json");
  const patch: Record<string, unknown> = { status };
  if (status === "active") patch.is_open = true;

  const { data, error } = await supabaseAdmin
    .from("stores")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: "Store not found" }, 404);
  return c.json({ store: data }, 200);
});

// ─── Staff: review a manual product / a price suggestion ─────────────
const productRoute = createRoute({
  method: "patch",
  path: "/admin/products/{id}/review",
  operationId: "reviewMerchantProduct",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: { params: IdParam, body: { ...json(reviewProductSchema), required: true } },
  responses: {
    200: json(z.object({ product: StoreProductSchema })),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(productRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: product } = await supabaseAdmin
    .from("store_products")
    .select("id, title, price, suggested_price, store:stores(id, name, owner_id)")
    .eq("id", id)
    .maybeSingle();
  if (!product) return c.json({ error: "Product not found" }, 404);

  const patch: Record<string, unknown> = {};
  if (body.review_status) patch.review_status = body.review_status;
  if (body.suggestion_status) {
    patch.suggestion_status = body.suggestion_status;
    if (body.suggestion_status === "accepted" && product.suggested_price != null) {
      patch.price = product.suggested_price;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("store_products")
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: "Product not found" }, 404);

  const store = (product as any).store;
  if (store?.owner_id && (body.suggestion_status === "rejected" || body.review_status === "rejected")) {
    const pricing = body.suggestion_status === "rejected";
    await createNotification({
      userId: store.owner_id,
      type: "alert",
      title: pricing ? "Item pricing flagged" : "Product not approved",
      description: pricing
        ? `${product.title}: your suggested price ${product.suggested_price} Da was declined. It stays at ${product.price} Da.`
        : `${product.title} at ${store.name} wasn't approved. Check its details and photos.`,
      contentFr: {
        title: pricing ? "Prix signalé" : "Produit non approuvé",
        description: pricing
          ? `${product.title} : votre prix proposé ${product.suggested_price} Da a été refusé. Il reste à ${product.price} Da.`
          : `${product.title} chez ${store.name} n'a pas été approuvé.`,
      },
      contentAr: {
        title: pricing ? "تم الإبلاغ عن السعر" : "لم تتم الموافقة على المنتج",
        description: pricing
          ? `${product.title}: تم رفض السعر المقترح ${product.suggested_price} دج. يبقى ${product.price} دج.`
          : `لم تتم الموافقة على ${product.title} في ${store.name}.`,
      },
      payload: {
        kind: pricing ? "pricing_flagged" : "product_rejected",
        product_id: product.id,
        store_id: store.id,
        suggested_price: product.suggested_price,
        price: product.price,
      },
    }).catch(() => null);
  }
  return c.json({ product: data }, 200);
});

// ─── Staff: approve / reject a pack in review ────────────────────────
const packRoute = createRoute({
  method: "patch",
  path: "/admin/packs/{id}/status",
  operationId: "reviewMerchantPack",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: {
    params: IdParam,
    body: {
      ...json(z.object({ status: z.enum(["active", "inactive"]) }).openapi("ReviewPackBody")),
      required: true,
    },
  },
  responses: {
    200: json(z.object({ pack: PackSchema })),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(packRoute, async (c) => {
  const { id } = c.req.valid("param");
  const { status } = c.req.valid("json");
  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
  if (error || !data) return c.json({ error: "Pack not found" }, 404);
  return c.json({ pack: data }, 200);
});

export default app;
