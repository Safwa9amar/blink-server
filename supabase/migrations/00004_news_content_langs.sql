-- =====================================================================
-- Blink Server — News: one content column per language
-- =====================================================================
-- Splits the single `content` JSONB ({ en, fr, ar }) into a column per
-- language so each language is composed and queried independently. Mirrors the
-- Drizzle schema (src/db/schema/news.ts: content_eng / content_fr / content_ar).

ALTER TABLE "news"
  ADD COLUMN IF NOT EXISTS "content_eng" jsonb,
  ADD COLUMN IF NOT EXISTS "content_fr"  jsonb,
  ADD COLUMN IF NOT EXISTS "content_ar"  jsonb;

-- Carry over any existing data from the old combined column.
UPDATE "news" SET
  content_eng = COALESCE(content_eng, content -> 'en'),
  content_fr  = COALESCE(content_fr,  content -> 'fr'),
  content_ar  = COALESCE(content_ar,  content -> 'ar')
WHERE content IS NOT NULL;

ALTER TABLE "news" DROP COLUMN IF EXISTS "content";
