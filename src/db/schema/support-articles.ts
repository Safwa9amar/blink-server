import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

export const supportArticleType = pgEnum("support_article_type", ["article", "faq"]);
export const supportArticleStatus = pgEnum("support_article_status", ["draft", "review", "published"]);

// Localized content for one article/FAQ. `body` is HTML for articles, the
// answer (text or simple HTML) for FAQs.
export interface SupportContent {
  title: string;
  body: string;
}

export const supportArticles = pgTable(
  "support_articles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: supportArticleType("type").notNull().default("article"),
    category: text("category").notNull(), // support_categories.key
    targetRoles: text("target_roles").array().notNull().default(["All"]),
    status: supportArticleStatus("status").notNull().default("draft"),
    contentEng: jsonb("content_eng").$type<SupportContent>(),
    contentFr: jsonb("content_fr").$type<SupportContent>(),
    contentAr: jsonb("content_ar").$type<SupportContent>(),
    coverUrl: text("cover_url"),
    author: text("author"),
    views: integer("views").notNull().default(0),
    helpfulUp: integer("helpful_up").notNull().default(0),
    helpfulDown: integer("helpful_down").notNull().default(0),
    sort: integer("sort").notNull().default(0),
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("idx_support_articles_status").on(t.status),
    index("idx_support_articles_type").on(t.type),
    index("idx_support_articles_category").on(t.category),
    // Clients read published only; staff manage via the service role.
    pgPolicy("support_articles_select_published", { for: "select", using: sql`status = 'published'` }),
  ]
);
