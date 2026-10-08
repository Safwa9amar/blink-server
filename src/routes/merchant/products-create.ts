import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  createMerchantProductSchema,
  MerchantProductResponse,
} from "../../validators/merchant";
import { ownedStore } from "./shared";

const app = router();

// ─── Merchant: add a product (from the Blink Library or manual) ──────
// Library products go live immediately; manual ones wait for staff review.
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
    400: errorResponses[400],
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

  const { library_product_id: _lib, ...fields } = body;
  const row = { ...base, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) } as Record<string, any>;
  const photos: string[] = row.photos ?? [];
  const price = row.price ?? 0;

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
