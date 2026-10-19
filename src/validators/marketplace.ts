// Validation + response schemas for the customer marketplace endpoints.
import { z } from "@hono/zod-openapi";
import { marketplaceCategories, storeProducts, stores } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

export const listStoresSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug" }),
  featured: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  q: z.string().optional().openapi({ description: "Search store names" }),
});

export const getStoreSchema = z.object({
  products: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v !== "false")
    .openapi({
      description:
        "`false` leaves out `products` (page them with GET /stores/{id}/products). Defaults to `true` for older app builds.",
    }),
});

export const listStoreProductsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(20),
  category: z.string().optional().openapi({
    description: "Menu category id (`Store.menu_categories[].id`); omit or `all` for every category",
  }),
  q: z.string().optional().openapi({ description: "Search title, description and unit" }),
});

export const lookupProductsSchema = z
  .object({
    ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .transform((ids) => [...new Set(ids)]),
  })
  .openapi("LookupProductsBody", { description: "store_products ids to refresh (e.g. a cart's lines)" });

// ─── Response schemas ────────────────────────────────────────────────

const menuCategorySchema = z
  .object({ id: z.string(), title: z.string() })
  .openapi("StoreMenuCategory");

export const MarketplaceCategorySchema = rowSchema(marketplaceCategories, "MarketplaceCategory");
// price_updated_by / price_update_source are write-only (they feed the price
// audit trigger): never part of a response.
export const StoreProductSchema = rowSchema(storeProducts, "StoreProduct")
  .omit({ price_updated_by: true, price_update_source: true })
  .openapi("StoreProduct");
export const StoreSchema = rowSchema(stores, "StoreRow")
  // Server-only (staff reviewer ids): stripped from every customer / merchant response.
  .omit({ document_review: true })
  .openapi("StoreRow")
  .extend({
    menu_categories: z.array(menuCategorySchema),
    next_open_at: z.string().nullable().optional().openapi({
      description:
        "While closed: when the weekly schedule next opens (ISO). Null when open, or closed until the merchant reopens.",
    }),
  })
  .openapi("Store");
export const StoreWithProductsSchema = StoreSchema.extend({
  products: z.array(StoreProductSchema).optional().openapi({
    description: "Every available product — absent with `?products=false`",
  }),
}).openapi("StoreWithProducts");

export const MarketplaceCategoryListResponse = z
  .object({ categories: z.array(MarketplaceCategorySchema) })
  .openapi("MarketplaceCategoryListResponse");
export const StoreListResponse = z
  .object({ stores: z.array(StoreSchema) })
  .openapi("StoreListResponse");
export const StoreResponse = z
  .object({ store: StoreWithProductsSchema })
  .openapi("StoreResponse");
export const StoreProductListResponse = z
  .object({ products: z.array(StoreProductSchema), pagination: PaginationSchema })
  .openapi("StoreProductListResponse");
export const LookupProductsResponse = z
  .object({ products: z.array(StoreProductSchema) })
  .openapi("LookupProductsResponse");

// ─── Packs (src/lib/pack-pricing.ts CustomerPack) ───────────────────

export const CustomerPackItemSchema = z
  .object({
    product_id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    unit: z.string().nullable(),
    /** The product's live price. */
    unit_price: z.number(),
    /** Charged units. */
    quantity: z.number().int(),
    free_qty: z.number().int().openapi({ description: "Free units given on top (buy-X-get-Y), not charged" }),
  })
  .openapi("CustomerPackItem");

export const CustomerPackSchema = z
  .object({
    id: z.string(),
    store_id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    /** The merchant's pack photo; null → show the products' photos. */
    image: z.string().nullable(),
    discount_percent: z.number().int().openapi({ description: "0 when the pack has no discount" }),
    free_delivery: z.boolean().openapi({
      description:
        "The store order ships free only when every line from that store is a pack with free_delivery; otherwise the store's delivery_fee applies (once per store order)",
    }),
    /** Σ quantity (charged units). */
    item_count: z.number().int(),
    /** Σ unit_price × quantity: the items bought separately. */
    original_price: z.number(),
    price: z.number().openapi({
      description: "What one pack costs (original_price − savings); send it as the order line's unit_price",
    }),
    savings: z.number(),
    items: z.array(CustomerPackItemSchema),
  })
  .openapi("CustomerPack");

export const CustomerPackListResponse = z
  .object({
    packs: z.array(CustomerPackSchema).openapi({ description: "Best savings first, then newest" }),
  })
  .openapi("CustomerPackListResponse");

// ─── Branch suggestion ("get it all from one branch") ───────────────

export const branchSuggestionQuerySchema = z.object({
  items: z.string().min(1).max(3000).openapi({
    description: "The cart as `product_id:quantity` pairs, comma-separated (up to 60)",
  }),
});

const BranchSuggestionSchema = z
  .object({
    to_store: z.object({ id: z.string(), name: z.string() }),
    from_store_ids: z.array(z.string()),
    swaps: z.array(
      z.object({
        from_product_id: z.string(),
        to_product: z.object({
          id: z.string(),
          title: z.string(),
          price: z.number(),
          image: z.string(),
        }),
      })
    ),
    saving: z.number(),
  })
  .openapi("BranchSuggestion");

export const BranchSuggestionResponse = z
  .object({ suggestion: BranchSuggestionSchema.nullable() })
  .openapi("BranchSuggestionResponse");
