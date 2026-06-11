-- =====================================================================
-- Blink Server — News CMS table
-- =====================================================================
-- Authored in Drizzle (src/db/schema/news.ts) and generated via
-- `npm run drizzle:generate` (drizzle/0001_news.sql). Kept here as a Supabase
-- migration so the existing `npm run db:push` / `db:reset` pipeline applies it.
-- Additive only — no changes to the baseline tables in 00001.

CREATE TYPE "public"."news_status" AS ENUM('published', 'scheduled', 'draft');

CREATE TABLE "news" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug"          text NOT NULL,
  "category"      text NOT NULL,
  "cover_url"     text,
  "target_roles"  text[] DEFAULT '{"All"}' NOT NULL,
  "status"        "news_status" DEFAULT 'draft' NOT NULL,
  "pinned"        boolean DEFAULT false NOT NULL,
  "push"          boolean DEFAULT false NOT NULL,
  "cta_label"     text,
  "content"       jsonb DEFAULT '{}'::jsonb NOT NULL,
  "views"         integer DEFAULT 0 NOT NULL,
  "clicks"        integer DEFAULT 0 NOT NULL,
  "author_id"     uuid,
  "published_at"  timestamp with time zone,
  "scheduled_at"  timestamp with time zone,
  "expires_at"    timestamp with time zone,
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "news_slug_unique" UNIQUE("slug")
);

ALTER TABLE "news" ENABLE ROW LEVEL SECURITY;

ALTER TABLE "news" ADD CONSTRAINT "news_author_id_users_id_fk"
  FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;

CREATE INDEX "idx_news_status" ON "news" USING btree ("status");
CREATE INDEX "idx_news_pinned" ON "news" USING btree ("pinned") WHERE pinned;
CREATE INDEX "idx_news_scheduled" ON "news" USING btree ("scheduled_at") WHERE status = 'scheduled';

-- App users read published posts; admin writes go through the service role.
CREATE POLICY "news_select_published" ON "news" AS PERMISSIVE FOR SELECT TO public USING (status = 'published');

-- updated_at auto-bump (reuses update_updated_at() from 00001).
CREATE TRIGGER trg_news_updated_at
  BEFORE UPDATE ON "news" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
