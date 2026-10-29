import { storeContextOf } from "../../lib/pricing/fees";
import { quoteStoreDelivery, type StoreDeliveryResult } from "../../lib/pricing/store-quote";
import {
  bestBranchMove,
  parseCartItems,
  type BranchProduct,
  type BranchStore,
  type CartLine,
  withQuotedFees,
} from "../../lib/branch-suggestion";
import { storeOpenState } from "../../lib/store-categories";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { branchSuggestionQuerySchema, BranchSuggestionResponse } from "../../validators/marketplace";

const app = router();

// ─── "Get it all from one branch" for a cart ─────────────────────────
// A hint: a failed lookup answers `suggestion: null`, never an error.
const route = createRoute({
  method: "get",
  path: "/branch-suggestion",
  operationId: "getBranchSuggestion",
  tags: ["marketplace"],
  security: bearer,
  request: { query: branchSuggestionQuerySchema },
  responses: {
    200: json(BranchSuggestionResponse),
    400: errorResponses[400],
  },
});

const PRODUCT_COLUMNS = "id, store_id, title, price, image, library_product_id, barcode";

app.openapi(route, async (c) => {
  const none = () => c.json({ suggestion: null }, 200);
  const query = c.req.valid("query");
  const wanted = parseCartItems(query.items);
  if (wanted.length < 2) return none();

  const { data: cartProducts } = await supabaseAdmin
    .from("store_products")
    .select("id, store_id, price, library_product_id, barcode")
    .in("id", [...new Set(wanted.map((w) => w.product_id))]);
  const byId = new Map((cartProducts ?? []).map((p) => [p.id, p]));
  const lines: CartLine[] = wanted.flatMap((w) => {
    const p = byId.get(w.product_id);
    return p
      ? [
          {
            product_id: p.id,
            store_id: p.store_id,
            quantity: w.quantity,
            price: Number(p.price) || 0,
            library_product_id: p.library_product_id ?? null,
            barcode: p.barcode ?? "",
          },
        ]
      : [];
  });
  const storeIds = [...new Set(lines.map((l) => l.store_id))];
  if (storeIds.length < 2) return none();

  const { data: storeRows } = await supabaseAdmin
    .from("stores")
    .select("id, name, owner_id, wilaya, latitude, longitude, delivery_fee, status, is_open, hours, manual_override")
    .in("id", storeIds);
  const baseStores = new Map<string, BranchStore>(
    (storeRows ?? []).map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        owner_id: s.owner_id,
        delivery_fee: Number(s.delivery_fee) || 0,
        open: s.status === "active" && storeOpenState(s).is_open,
      },
    ])
  );

  // Each store's delivery fee as checkout would charge it at the customer point
  // (same quoteStoreDelivery as POST /orders/quote and /orders), so the saving
  // is real. No point → the merchant fee, as checkout would then.
  const customer = query.lat != null && query.lng != null ? { lat: query.lat, lng: query.lng } : null;
  const quotes = new Map<string, StoreDeliveryResult>();
  await Promise.all(
    (storeRows ?? []).map(async (s) => {
      const ctx = await storeContextOf(s, "merchant", customer);
      const store = s.latitude != null && s.longitude != null ? { lat: Number(s.latitude), lng: Number(s.longitude) } : null;
      quotes.set(s.id, await quoteStoreDelivery({ ctx, merchantFee: Number(s.delivery_fee) || 0, store, customer }));
    })
  );
  const stores = withQuotedFees(baseStores, new Map([...quotes].map(([id, q]) => [id, q.fee])));

  // Candidate targets: storefront-visible products in the cart's stores that
  // share a catalog id or barcode with a cart line.
  const libraryIds = [
    ...new Set(lines.map((l) => l.library_product_id).filter((id): id is string => !!id)),
  ];
  const barcodes = [...new Set(lines.map((l) => l.barcode).filter(Boolean))];
  const visible = () =>
    supabaseAdmin
      .from("store_products")
      .select(PRODUCT_COLUMNS)
      .in("store_id", storeIds)
      .eq("is_available", true)
      .eq("review_status", "approved");
  const [byLibrary, byBarcode] = await Promise.all([
    libraryIds.length ? visible().in("library_product_id", libraryIds) : null,
    barcodes.length ? visible().in("barcode", barcodes) : null,
  ]);
  const candidates = new Map<string, BranchProduct>();
  for (const p of [...(byLibrary?.data ?? []), ...(byBarcode?.data ?? [])]) {
    candidates.set(p.id, {
      id: p.id,
      store_id: p.store_id,
      title: p.title,
      price: Number(p.price) || 0,
      image: p.image ?? "",
      library_product_id: p.library_product_id ?? null,
      barcode: p.barcode ?? "",
    });
  }

  const suggestion = bestBranchMove(lines, stores, [...candidates.values()]);
  if (!suggestion) return c.json({ suggestion }, 200);
  // The mode tells the app when the target's fee is priced by distance instead.
  const target = quotes.get(suggestion.to_store.id);
  return c.json(
    {
      suggestion: {
        ...suggestion,
        to_store: {
          ...suggestion.to_store,
          delivery_fee_mode: target?.configuredMode ?? ("merchant" as const),
          delivery_fee: target?.fee,
        },
      },
    },
    200
  );
});

export default app;
