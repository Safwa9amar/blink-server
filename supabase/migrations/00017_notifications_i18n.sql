-- =====================================================================
-- Blink Server — Notifications localized content
-- =====================================================================
-- The dashboard composer captures trilingual (en/fr/ar) title+message. Store
-- each language in its own JSONB column ({ title, description }), mirroring
-- news.content_*. `title`/`description` on the row stay the canonical (English)
-- fallback the app renders when a language block is absent. Additive only.

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "content_eng" jsonb,
  ADD COLUMN IF NOT EXISTS "content_fr"  jsonb,
  ADD COLUMN IF NOT EXISTS "content_ar"  jsonb;
