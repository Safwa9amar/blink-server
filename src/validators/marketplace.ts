// Validation + response schemas for the customer marketplace endpoints.
import { z } from "@hono/zod-openapi";
import { marketplaceCategories, storeProducts, stores } from "../db/schema";
import { rowSchema } from "../openapi";

export const listStoresSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug" }),
  featured: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  q: z.string().optional().openapi({ description: "Search store names" }),
});

// ─── Response schemas ────────────────────────────────────────────────

const menuCategorySchema = z
  .object({ id: z.string(), title: z.string() })
  .openapi("StoreMenuCategory");

export const MarketplaceCategorySchema = rowSchema(marketplaceCategories, "MarketplaceCategory");
export const StoreProductSchema = rowSchema(storeProducts, "StoreProduct");
export const StoreSchema = rowSchema(stores, "StoreRow")
  .extend({ menu_categories: z.array(menuCategorySchema) })
  .openapi("Store");
export const StoreWithProductsSchema = StoreSchema.extend({
  products: z.array(StoreProductSchema),
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
