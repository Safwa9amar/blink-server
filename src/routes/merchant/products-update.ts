import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  MerchantProductResponse,
  updateMerchantProductSchema,
} from "../../validators/merchant";
import { ownedProduct, PRICE_TOLERANCE } from "./shared";

const app = router();

// ─── Merchant: update a product (details, stock, availability, price) ─
const route = createRoute({
  method: "patch",
  path: "/products/{id}",
  operationId: "updateMerchantProduct",
  tags: ["merchant"],
  security: bearer,
  request: {
    params: IdParam,
    body: { ...json(updateMerchantProductSchema), required: true },
  },
  responses: {
    200: json(MerchantProductResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { suggested_price, ...body } = c.req.valid("json");

  const product = await ownedProduct(user.id, id);
  if (!product) return c.json({ error: "Product not found" }, 404);

  const patch: Record<string, unknown> = Object.fromEntries(
    Object.entries(body).filter(([, v]) => v !== undefined)
  );
  if (body.photos) patch.image = body.photos[0] ?? "";

  // Price suggestion: within tolerance of Blink's reference → applied now,
  // otherwise it waits for staff review.
  if (suggested_price !== undefined) {
    const ref = Number(product.blink_price) || Number(product.price) || 0;
    const within =
      ref === 0 ||
      (suggested_price >= ref * (1 - PRICE_TOLERANCE) &&
        suggested_price <= ref * (1 + PRICE_TOLERANCE));
    patch.suggested_price = suggested_price;
    patch.suggestion_status = within ? "accepted" : "pending";
    if (within) {
      patch.price = suggested_price;
      if (ref === 0) patch.blink_price = suggested_price;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("store_products")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Product not found" }, 400);
  return c.json({ product: data }, 200);
});

export default app;
