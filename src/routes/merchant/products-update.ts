import {
  merchantWritableFields,
  resolveProductUpdate,
  type ProductEdit,
  type ProductReviewState,
} from "../../lib/product-review";
import { priceAttribution, withoutPriceAttribution } from "../../lib/price-history";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  CatalogError,
  MerchantProductResponse,
  updateMerchantProductSchema,
} from "../../validators/merchant";
import { ownedProduct } from "./shared";

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
    400: json(CatalogError, "Bad request (code price_invalid: the price must be > 0)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(CatalogError, "The product changed since it was read (code stale) — reload and retry"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { suggested_price, price, ...body } = c.req.valid("json");

  const product = await ownedProduct(user.id, id);
  if (!product) return c.json({ error: "Product not found" }, 404);

  // A library product keeps the library's content: only its category, stock
  // and availability are the merchant's (src/lib/product-review.ts).
  const fields = merchantWritableFields(!!product.library_product_id, body) as ProductEdit;

  // `price` is never written directly: a changed price is a price suggestion
  // (auto-applied within tolerance of Blink's reference, otherwise staff
  // review); editing a rejected product resubmits it, and renaming /
  // re-photographing an approved manual one sends it back to review.
  const review = resolveProductUpdate(product as ProductReviewState, { ...fields, price, suggested_price });
  if (!review.ok) return c.json({ error: review.error, code: review.code }, 400);

  const patch: Record<string, unknown> = { ...fields, ...review.columns };
  // An auto-accepted suggestion moves the live price: log it as the merchant's.
  Object.assign(patch, priceAttribution(patch, "merchant", user.id));
  if (fields.photos) patch.image = fields.photos[0] ?? "";
  if (Object.keys(patch).length === 0) return c.json({ product: withoutPriceAttribution(product) as any }, 200);

  // Optimistic concurrency: only write over the row the rules were applied to.
  const { data, error } = await supabaseAdmin
    .from("store_products")
    .update(patch)
    .eq("id", id)
    .eq("updated_at", product.updated_at)
    .select()
    .maybeSingle();

  if (error) return c.json({ error: error.message }, 400);
  if (!data) {
    return c.json(
      { error: "This item changed while you were editing it. Reload and try again.", code: "stale" as const },
      409
    );
  }
  return c.json({ product: withoutPriceAttribution(data) }, 200);
});

export default app;
