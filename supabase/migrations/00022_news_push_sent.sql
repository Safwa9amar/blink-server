-- =====================================================================
-- Blink Server — News: track when the publish-push was delivered
-- =====================================================================
-- The dashboard composer's "Send push" toggle only stored `push = true`; no push
-- was ever delivered, and scheduled posts never auto-published. The news cron
-- (POST /cron/news, every minute) now (a) publishes due scheduled posts,
-- (b) delivers the publish push for published posts with push=true that haven't
-- been pushed yet, and (c) unpublishes expired posts.
--
-- `push_sent_at` makes (b) idempotent: NULL = not pushed yet. We BACKFILL all
-- existing published rows so the cron's first run doesn't mass-push history —
-- only posts published AFTER this migration (push_sent_at NULL) get a push.
-- Mirrors src/db/schema/news.ts.

ALTER TABLE news ADD COLUMN IF NOT EXISTS push_sent_at TIMESTAMPTZ;

-- Don't re-push anything already live.
UPDATE news
SET push_sent_at = COALESCE(published_at, now())
WHERE status = 'published' AND push_sent_at IS NULL;

-- Pending publish-pushes: published, push on, not yet delivered.
CREATE INDEX IF NOT EXISTS idx_news_push_pending
  ON news (status)
  WHERE push = true AND push_sent_at IS NULL;
