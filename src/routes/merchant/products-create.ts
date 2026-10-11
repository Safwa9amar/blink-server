import { merchantWritableFields, newProductPriceError } from "../../lib/product-review";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  CatalogError,
  createMerchantProductSchema,
  MerchantProductResponse,
} from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: add a product (from the Blink Library or manual) ──────
// Library products go live immediately with the library's content (the
// merchant only sets price, stock, availability and store category); manual
// ones wait for staff review.
const route = createRoute({
  method: "post",
  path: "/stores/{id}/products",
  operationId: "createMerchantProduct",
  tags: ["merchant"],
  security: bearer,
  request: {
    params: IdParam,
    body: { ...json(createMerchantProductSchema), required: true },
  },
  responses: {
    201: json(MerchantProductResponse, "Created"),
    400: json(CatalogError, "Bad request (code price_invalid: the price must be > 0)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: storeId } = c.req.valid("param");
  const body = c.req.valid("json");
  if (!(await ownedStore(user.id, storeId))) return c.json({ error: "Store not found" }, 404);
  // Every new product needs a price > 0: a manual one's becomes its Blink
  // reference price, and a library one is approved (live) at once.
  const priceError = newProductPriceError(!!body.library_product_id, body.price);
  if (priceError) return c.json({ error: priceError, code: "price_invalid" as const }, 400);

  let base: Record<string, unknown> = {};
  if (body.library_product_id) {
    const { data: lib } = await supabaseAdmin
      .from("library_products")
      .select("*")
      .eq("id", body.library_product_id)
      .eq("status", "published")
      .maybeSingle();
    if (!lib) return c.json({ error: "Library product not found" }, 404);

    const { data: dup } = await supabaseAdmin
      .from("store_products")
      .select("id")
      .eq("store_id", storeId)
      .eq("library_product_id", lib.id)
      .maybeSingle();
    if (dup) return c.json({ error: "Product already in this store" }, 400);

    base = {
      title: lib.name_en || lib.name_fr || lib.name_ar,
      description: lib.description_en || null,
      barcode: lib.barcode,
      brand: lib.brand,
      category: lib.category,
      unit: lib.unit || null,
      photos: lib.photos ?? [],
      library_product_id: lib.id,
      review_status: "approved",
    };
  } else {
    base = { review_status: "pending" };
  }

  // A library product keeps the library's title / photos / description /
  // brand / barcode / unit: it is approved because that content is Blink's.
  const { library_product_id: _lib, price: _price, ...fields } = body;
  const row = { ...base, ...merchantWritableFields(!!body.library_product_id, fields) } as Record<string, any>;
  const photos: string[] = row.photos ?? [];
  const price = body.price as number; // > 0, checked above

  const { data, error } = await supabaseAdmin
    .from("store_products")
    .insert({
      ...row,
      store_id: storeId,
      image: photos[0] ?? "",
      price,
      blink_price: price,
    })
    .select()
    .single();

  if (error || !data) return c.json({ error: error?.message ?? "Could not add product" }, 400);

  if (body.library_product_id) {
    // Keep the library's "stores stocking this item" metric in step.
    const { count } = await supabaseAdmin
      .from("store_products")
      .select("id", { count: "exact", head: true })
      .eq("library_product_id", body.library_product_id);
    await supabaseAdmin
      .from("library_products")
      .update({ store_count: count ?? 0 })
      .eq("id", body.library_product_id);
  }

  return c.json({ product: data }, 201);
});

export default app;
