import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Lives here (not in enums.ts) so it ships in the additive `news` migration
// rather than the baseline snapshot of the already-deployed tables.
export const newsStatus = pgEnum("news_status", ["published", "scheduled", "draft"]);

// Per-language copy for a post. `body` is HTML authored in the rich editor;
// `title`/`sum` are the admin-list display strings. Mirrors the dashboard's
// PostContent type (src/features/news/types.ts). Stored per language in its own
// column (content_eng / content_fr / content_ar) so each language is composed and
// queried independently.
export interface NewsCopy {
  title: string;
  sum: string;
  body: string;
}

// Blink News CMS — the first feature promoted from mock to a real table.
// Backs the dashboard `/d/news` admin and (later) the mobile-app news feed.
export const news = pgTable(
  "news",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(), // display id e.g. "fuel-cashback"
    category: text("category").notNull(), // "Network" | "Offer" | … (free text; lookup table is a later step)
    coverUrl: text("cover_url"),
    targetRoles: text("target_roles").array().notNull().default(["All"]), // ["All"] | ["Rider"] …
    status: newsStatus("status").notNull().default("draft"),
    pinned: boolean("pinned").notNull().default(false),
    push: boolean("push").notNull().default(false), // send a push notification on publish
    ctaLabel: text("cta_label"),
    // One JSONB column per language ({ title, sum, body }); null until composed.
    contentEng: jsonb("content_eng").$type<NewsCopy>(),
    contentFr: jsonb("content_fr").$type<NewsCopy>(),
    contentAr: jsonb("content_ar").$type<NewsCopy>(),
    views: integer("views").notNull().default(0),
    clicks: integer("clicks").notNull().default(0), // ctr = clicks / views (derived in UI)
    authorId: uuid("author_id").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true, mode: "string" }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    ...timestamps,
  },
  (t) => [
    index("idx_news_status").on(t.status),
    index("idx_news_pinned")
      .on(t.pinned)
      .where(sql`pinned`),
    index("idx_news_scheduled")
      .on(t.scheduledAt)
      .where(sql`status = 'scheduled'`),
    // App users read published posts; admin writes go through the service role
    // (bypasses RLS), same as the rest of the dashboard's mutations.
    pgPolicy("news_select_published", { for: "select", using: sql`status = 'published'` }),
  ]
);
