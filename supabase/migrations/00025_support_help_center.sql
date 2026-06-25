-- =====================================================================
-- Blink Server — Help Center (support categories + articles/FAQs)
-- =====================================================================
-- Authored to mirror src/db/schema/support-categories.ts +
-- support-articles.ts. Applied via the existing `npm run db:push` pipeline.
-- Additive only.
--   support_categories — the "Common Topics" tiles / FAQ groups, role-scoped.
--     SELECT is open to any authenticated client (no sensitive data).
--   support_articles   — rich articles AND FAQ Q&A in one table, keyed by
--     `type`. Clients read published rows only; staff manage via the service
--     role. Both tables join supabase_realtime so the app & dashboard can
--     subscribe (RLS-scoped).

CREATE TYPE "public"."support_article_type" AS ENUM('article', 'faq');
CREATE TYPE "public"."support_article_status" AS ENUM('draft', 'review', 'published');

CREATE TABLE IF NOT EXISTS "support_categories" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key"           text NOT NULL,
  "target_roles"  text[] DEFAULT '{"All"}' NOT NULL,
  "label_eng"     text NOT NULL,
  "label_fr"      text,
  "label_ar"      text,
  "icon"          text DEFAULT 'questionmark.circle' NOT NULL,
  "color"         text DEFAULT '#3B82F6' NOT NULL,
  "sort"          integer DEFAULT 0 NOT NULL,
  "created_at"    timestamptz DEFAULT now() NOT NULL,
  "updated_at"    timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "support_articles" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "type"          "support_article_type" DEFAULT 'article' NOT NULL,
  "category"      text NOT NULL,
  "target_roles"  text[] DEFAULT '{"All"}' NOT NULL,
  "status"        "support_article_status" DEFAULT 'draft' NOT NULL,
  "content_eng"   jsonb,
  "content_fr"    jsonb,
  "content_ar"    jsonb,
  "cover_url"     text,
  "author"        text,
  "views"         integer DEFAULT 0 NOT NULL,
  "helpful_up"    integer DEFAULT 0 NOT NULL,
  "helpful_down"  integer DEFAULT 0 NOT NULL,
  "sort"          integer DEFAULT 0 NOT NULL,
  "author_id"     uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
  "created_at"    timestamptz DEFAULT now() NOT NULL,
  "updated_at"    timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_support_categories_sort"   ON "support_categories" USING btree ("sort");
CREATE INDEX IF NOT EXISTS "idx_support_articles_status"   ON "support_articles" USING btree ("status");
CREATE INDEX IF NOT EXISTS "idx_support_articles_type"     ON "support_articles" USING btree ("type");
CREATE INDEX IF NOT EXISTS "idx_support_articles_category" ON "support_articles" USING btree ("category");

ALTER TABLE "support_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_articles" ENABLE ROW LEVEL SECURITY;

-- Categories carry no sensitive data — readable by any authenticated client.
DROP POLICY IF EXISTS "support_categories_select_all" ON "support_categories";
CREATE POLICY "support_categories_select_all" ON "support_categories"
  AS PERMISSIVE FOR SELECT TO public USING (true);

-- Clients read published only; staff manage via the service role.
DROP POLICY IF EXISTS "support_articles_select_published" ON "support_articles";
CREATE POLICY "support_articles_select_published" ON "support_articles"
  AS PERMISSIVE FOR SELECT TO public USING (status = 'published');

-- updated_at auto-bump (reuses update_updated_at() from the baseline migration).
CREATE TRIGGER trg_support_categories_updated_at
  BEFORE UPDATE ON "support_categories" FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_support_articles_updated_at
  BEFORE UPDATE ON "support_articles" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Realtime ────────────────────────────────────────────────────────
-- postgres_changes needs full row images for deletes/updates and the tables
-- in the supabase_realtime publication. Subscribers are RLS-scoped.
ALTER TABLE "support_categories" REPLICA IDENTITY FULL;
ALTER TABLE "support_articles" REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_categories;
ALTER PUBLICATION supabase_realtime ADD TABLE public.support_articles;
