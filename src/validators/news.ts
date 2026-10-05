import { z } from "@hono/zod-openapi";
import { news } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

// ─── Params / query ──────────────────────────────────────────────────

/** `/{id}` accepts either the post's uuid or its slug. */
export const NewsIdParam = z.object({
  id: z
    .string()
    .openapi({ param: { name: "id", in: "path" }, description: "News post id (uuid) or slug" }),
});

// Kept as raw strings: the handler does its own clamped `Number(...)` coercion.
export const listNewsQuery = z.object({
  page: z.string().optional().openapi({ example: "1" }),
  limit: z.string().optional().openapi({ example: "20" }),
  category: z.string().optional().openapi({ example: "Offer" }),
});

// ─── Response schemas ────────────────────────────────────────────────

/** A post as the feed returns it — the `FEED_COLUMNS` subset of the row. */
// Inline (unnamed) so `nullable` survives — OpenAPI 3.0 drops it next to a $ref.
const NewsCopySchema = z.object({ title: z.string(), sum: z.string(), body: z.string() });

export const NewsPostSchema = rowSchema(news, "NewsRow")
  .pick({
    id: true,
    slug: true,
    category: true,
    cover_url: true,
    target_roles: true,
    status: true,
    pinned: true,
    push: true,
    cta_label: true,
    content_eng: true,
    content_fr: true,
    content_ar: true,
    views: true,
    published_at: true,
    expires_at: true,
    created_at: true,
  })
  // jsonb columns re-typed from the generic JSON union to their real shape.
  .extend({
    content_eng: NewsCopySchema.nullable(),
    content_fr: NewsCopySchema.nullable(),
    content_ar: NewsCopySchema.nullable(),
  })
  .openapi("NewsPost");

export const NewsListResponse = z
  .object({ news: z.array(NewsPostSchema), pagination: PaginationSchema })
  .openapi("NewsListResponse");

export const NewsDetailResponse = z
  .object({ news: NewsPostSchema })
  .openapi("NewsDetailResponse");

export const NewsClickResponse = z
  .object({ message: z.string(), clicks: z.number().int() })
  .openapi("NewsClickResponse");
