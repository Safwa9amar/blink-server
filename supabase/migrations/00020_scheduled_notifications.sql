-- =====================================================================
-- Blink Server — Scheduled (queued) broadcast notifications
-- =====================================================================
-- A queue for broadcasts that fire at a future time. The dashboard composer
-- enqueues one row; a cron (POST /cron/scheduled-notifications, driven every
-- minute by a cPanel Cron Job) claims due rows and runs broadcastNotification()
-- — the SAME delivery path "send now" uses, so a scheduled send produces the
-- identical notifications + notification_recipients rows + Expo pushes.
--
-- This is the QUEUE, not the delivered content: once fired, the real rows live
-- in notifications / notification_recipients. The queue row is kept for status
-- + audit (recipients / pushed / sent_at / error).
-- Mirrors src/db/schema/scheduled-notifications.ts.

CREATE TYPE scheduled_notification_status AS ENUM (
  'pending',   -- waiting for its time
  'sending',   -- claimed by the cron (prevents double-send across overlapping runs)
  'sent',      -- fanned out successfully
  'failed',    -- broadcast threw; see `error`
  'canceled'   -- staff canceled a still-pending row
);

CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          notification_type NOT NULL,
  title         TEXT NOT NULL,                 -- canonical (English) fallback
  description   TEXT NOT NULL,
  href          TEXT,                          -- explicit deep-link override
  content_eng   JSONB,                         -- { title, description } per language
  content_fr    JSONB,
  content_ar    JSONB,
  target_roles  TEXT[] NOT NULL,               -- lowercase user_role values
  channels      TEXT[] NOT NULL DEFAULT ARRAY['push']::text[], -- push|inapp|email|sms
  scheduled_at  TIMESTAMPTZ NOT NULL,          -- when to fire
  status        scheduled_notification_status NOT NULL DEFAULT 'pending',
  recipients    INTEGER NOT NULL DEFAULT 0,    -- filled in once fired
  pushed        INTEGER NOT NULL DEFAULT 0,
  sent_at       TIMESTAMPTZ,
  error         TEXT,
  created_by    UUID,                          -- staff/sender (null for system)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The due-queue scan: pending rows ordered by when they fire.
CREATE INDEX IF NOT EXISTS idx_scheduled_notifications_due
  ON scheduled_notifications (scheduled_at)
  WHERE status = 'pending';

-- RLS on; the only policy denies direct reads (USING false). Inserts/updates/
-- deletes have no policy → also denied. Only the service role (dashboard admin
-- client + the server cron) bypasses RLS and touches this queue.
ALTER TABLE scheduled_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY scheduled_notifications_no_client_access ON scheduled_notifications
  FOR SELECT USING (false);
