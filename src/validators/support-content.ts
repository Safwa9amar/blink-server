import { z } from "@hono/zod-openapi";
import { supportArticles } from "../db/schema/support-articles";
import { supportCategories } from "../db/schema/support-categories";
import { rowSchema } from "../openapi";

// ─── Query ───────────────────────────────────────────────────────────

// `type` stays a raw string: the handler only filters on "article" | "faq" and
// silently ignores any other value.
export const listSupportArticlesQuery = z.object({
  type: z
    .string()
    .optional()
    .openapi({ description: '"article" or "faq" (other values are ignored)', example: "faq" }),
  category: z.string().optional().openapi({ description: "support_categories.key" }),
});

// ─── Response schemas ────────────────────────────────────────────────

export const SupportCategorySchema = rowSchema(supportCategories, "SupportCategory");
// Inline (unnamed) so `nullable` survives — OpenAPI 3.0 drops it next to a $ref.
const SupportContentSchema = z.object({ title: z.string(), body: z.string() });

// jsonb columns re-typed from the generic JSON union to their real shape.
// Rebuilt from `.shape` (not `.extend`) so the spec gets a flat object rather
// than an allOf over the generic row.
export const SupportArticleSchema = z
  .object({
    ...rowSchema(supportArticles, "SupportArticleRow").shape,
    content_eng: SupportContentSchema.nullable(),
    content_fr: SupportContentSchema.nullable(),
    content_ar: SupportContentSchema.nullable(),
  })
  .openapi("SupportArticle");

export const SupportCategoryListResponse = z
  .object({ categories: z.array(SupportCategorySchema) })
  .openapi("SupportCategoryListResponse");

export const SupportArticleListResponse = z
  .object({ articles: z.array(SupportArticleSchema) })
  .openapi("SupportArticleListResponse");

export const SupportArticleResponse = z
  .object({ article: SupportArticleSchema })
  .openapi("SupportArticleResponse");
