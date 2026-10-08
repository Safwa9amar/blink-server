import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { LibraryListResponse, listLibrarySchema } from "../../validators/merchant";

const app = router();

// ─── Merchant: browse the Blink Library (published items) ────────────
const route = createRoute({
  method: "get",
  path: "/library",
  operationId: "listMerchantLibrary",
  tags: ["merchant"],
  security: bearer,
  request: { query: listLibrarySchema },
  responses: {
    200: json(LibraryListResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
  },
});

const COLUMNS =
  "id, name_en, name_fr, name_ar, description_en, description_fr, description_ar, barcode, brand, category, unit, photos";

app.openapi(route, async (c) => {
  const { q, category } = c.req.valid("query");

  let query = supabaseAdmin
    .from("library_products")
    .select(COLUMNS)
    .eq("status", "published")
    .order("name_en", { ascending: true })
    .limit(200);
  if (category) query = query.eq("category", category);
  if (q) {
    const term = q.replace(/[%,()]/g, " ").trim();
    query = query.or(
      `name_en.ilike.%${term}%,name_fr.ilike.%${term}%,name_ar.ilike.%${term}%,brand.ilike.%${term}%,barcode.ilike.%${term}%`
    );
  }

  const [{ data, error }, { data: cats }] = await Promise.all([
    query,
    supabaseAdmin
      .from("library_categories")
      .select("name_en")
      .eq("status", "active")
      .order("sort_order", { ascending: true }),
  ]);
  if (error) return c.json({ error: error.message }, 400);

  return c.json(
    {
      products: data ?? [],
      categories: (cats ?? []).map((r: { name_en: string }) => r.name_en).filter(Boolean),
    },
    200
  );
});

export default app;
