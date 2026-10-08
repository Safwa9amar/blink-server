// Validation + response schemas for customer favorites.
import { z } from "@hono/zod-openapi";
import { StoreProductSchema, StoreSchema } from "./marketplace";

const targetType = z.enum(["store", "product"]);

export const favoriteBodySchema = z
  .object({ target_type: targetType, target_id: z.string().uuid() })
  .openapi("FavoriteBody");

export const FavoriteParams = z.object({
  target_type: targetType.openapi({ param: { name: "target_type", in: "path" } }),
  target_id: z.string().uuid().openapi({ param: { name: "target_id", in: "path" } }),
});

// ─── Response schemas ────────────────────────────────────────────────

export const FavoriteProductSchema = StoreProductSchema.extend({
  store_name: z.string(),
}).openapi("FavoriteProduct");

export const FavoriteListResponse = z
  .object({
    store_ids: z.array(z.string()),
    product_ids: z.array(z.string()),
    stores: z.array(StoreSchema),
    products: z.array(FavoriteProductSchema),
  })
  .openapi("FavoriteListResponse");
