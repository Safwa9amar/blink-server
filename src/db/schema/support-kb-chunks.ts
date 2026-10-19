import { sql } from "drizzle-orm";
import { customType, index, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { supportArticles } from "./support-articles";

// pgvector column with NO fixed dimension (so the embedding model can change).
// Lives in the `extensions` schema; PostgREST returns it as a "[0.1,0.2,…]" string.
const vector = customType<{ data: string; driverData: string }>({
  dataType() {
    return "extensions.vector";
  },
});

// Generated tsvector (see migration): to_tsvector('simple', title || ' ' || content).
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// Retrieval chunks of published support articles/FAQs, per locale. Built and
// refreshed by lib/support-kb-index.ts; queried via the match_support_kb() SQL
// function. Service-role only (RLS on, no policies).
export const supportKbChunks = pgTable(
  "support_kb_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => supportArticles.id, { onDelete: "cascade" }),
    locale: text("locale").notNull(), // en | fr | ar
    chunkIndex: integer("chunk_index").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true, mode: "string" }).notNull(),
    embedding: vector("embedding"),
    embeddingModel: text("embedding_model").notNull(),
    fts: tsvector("fts").generatedAlwaysAs(sql`to_tsvector('simple', title || ' ' || content)`),
    ...timestamps,
  },
  (t) => [
    unique("support_kb_chunks_article_locale_idx_key").on(t.articleId, t.locale, t.chunkIndex),
    index("idx_support_kb_chunks_article").on(t.articleId),
    index("idx_support_kb_chunks_fts").using("gin", t.fts),
  ]
);
