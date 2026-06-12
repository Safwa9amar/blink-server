-- =====================================================================
-- Blink Server — Notifications: shared content + per-user archive
-- =====================================================================
-- Splits the per-user fan-out model into shared CONTENT (notifications) + a
-- per-user junction (notification_recipients). A broadcast becomes 1 content
-- row + N recipient rows instead of N duplicated content rows. Per-user
-- read/archive state moves to the junction; the app's "delete" is an ARCHIVE
-- (set archived_at, never a row delete), so notifications are never lost.
-- Mirrors src/db/schema/notification-recipients.ts + the reshaped notifications.

-- ─── 1. Per-user recipient/state table ───────────────────────────────
CREATE TABLE IF NOT EXISTS notification_recipients (
  notification_id UUID NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_unread       BOOLEAN NOT NULL DEFAULT true,
  archived_at     TIMESTAMPTZ,                       -- per-user archive ("delete")
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

-- Feed reads: per-user, split active (archived_at IS NULL) vs archived.
CREATE INDEX IF NOT EXISTS idx_notification_recipients_user
  ON notification_recipients (user_id, archived_at);
-- Unread badge: per-user, only unread rows.
CREATE INDEX IF NOT EXISTS idx_notification_recipients_unread
  ON notification_recipients (user_id)
  WHERE is_unread = true;

ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_recipients_select_own ON notification_recipients
  FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY notification_recipients_update_own ON notification_recipients
  FOR UPDATE USING (auth.uid() = user_id);

-- ─── 2. Backfill one recipient per existing notification row ─────────
-- Each existing (per-user) notification becomes one recipient of itself. The
-- old soft-delete `deleted_at` maps to the new `archived_at`. Historical
-- broadcasts stay content-duplicated (one notification + one recipient each) —
-- regrouping past fan-outs is unreliable and out of scope.
INSERT INTO notification_recipients (notification_id, user_id, is_unread, archived_at, created_at)
SELECT id, user_id, is_unread, deleted_at, created_at
FROM notifications
WHERE user_id IS NOT NULL
ON CONFLICT (notification_id, user_id) DO NOTHING;

-- ─── 3. Reshape notifications into the shared content table ─────────
-- Drop per-user columns + their indexes/policies; add audit columns.
DROP POLICY IF EXISTS notifications_select_own ON notifications;
DROP POLICY IF EXISTS notifications_update_own ON notifications;
DROP INDEX IF EXISTS idx_notifications_user;
DROP INDEX IF EXISTS idx_notifications_unread;
DROP INDEX IF EXISTS idx_notifications_user_active;

ALTER TABLE notifications
  DROP COLUMN IF EXISTS user_id,
  DROP COLUMN IF EXISTS is_unread,
  DROP COLUMN IF EXISTS deleted_at,
  ADD COLUMN IF NOT EXISTS target_roles TEXT[],
  ADD COLUMN IF NOT EXISTS created_by UUID;

-- Direct client reads are allowed only for notifications the caller received
-- (the server reads via the service role + the recipient join).
CREATE POLICY notifications_select_recipient ON notifications
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM notification_recipients nr
      WHERE nr.notification_id = notifications.id AND nr.user_id = auth.uid()
    )
  );
