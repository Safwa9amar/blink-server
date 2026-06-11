# Notifications: shared content + per-user archive — design

**Date:** 2026-06-12
**Repos touched:** `blink-server` (schema + API, source of truth), `blink-dashboard` (broadcast composer + analytics), `blink` (mobile feed/archive UI)
**Status:** approved design — pending spec review

## Goal

A notification must **never be lost when a user "deletes" it**. Deleting only
moves it to a per-user **archive** the user can still open (and restore) later.
Separately, a single notification (e.g. a dashboard broadcast) is **one piece of
content delivered to many users**, not N duplicated rows — so it scales, and one
recipient's actions never affect another's.

## Problem with today's model (fan-out)

`notifications` has one row **per user** (`user_id`, `is_unread`, `deleted_at` on
the row). `broadcastNotification` / dashboard `sendCampaign` fetch every user in
the target roles and **insert one full content row per user** — title, localized
copy and payload duplicated N times. A 184k-recipient campaign = 184k content
rows, with no single "campaign" record. Per-user delete already works (each user
owns their row), but there is no shared content and no real archive concept.

## Approach: two tables (content + recipients)

### `notifications` — the content/campaign (one row per message)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | **shared, canonical** id used in URLs and deep links |
| `type` | notification_type | unchanged |
| `title`, `description` | text | canonical/English fallback copy |
| `payload` | jsonb | typed-variant payload |
| `content_eng` / `content_fr` / `content_ar` | jsonb | localized `{title, description}` |
| `href` | text, null | **explicit override only** (e.g. dashboard "link"); see Deep links |
| `target_roles` | text[], null | NEW — audit/analytics: roles the campaign targeted |
| `created_by` | uuid, null | NEW — staff/sender; null for system notifications |
| `created_at` | timestamptz | unchanged |

**Removed:** `user_id`, `is_unread`, `deleted_at` (move to recipients).

### `notification_recipients` — per-user state (NEW)

| column | type | notes |
|---|---|---|
| `notification_id` | uuid | FK → notifications(id) **ON DELETE CASCADE** |
| `user_id` | uuid | FK → users(id) **ON DELETE CASCADE** |
| `is_unread` | boolean, default true | per-user read state |
| `archived_at` | timestamptz, null | per-user archive marker — "delete" sets this |
| `created_at` | timestamptz, default now() | |

- **PRIMARY KEY `(notification_id, user_id)`** — natural composite key, no surrogate id.
- Indexes: `(user_id, archived_at)` for the feed; partial `(user_id) WHERE is_unread` for the unread badge.
- RLS: `select`/`update` where `auth.uid() = user_id`.

### Properties this gives us

- **Archive, never lose:** "delete" = `UPDATE notification_recipients SET archived_at = now()` on the user's own row. Content and other recipients untouched. Restorable.
- **Shared content:** broadcast = **1 `notifications` row + N small `notification_recipients` rows**. No content duplication.
- **User deletion is safe:** deleting a user cascades only their recipient rows; the notification content survives for everyone else.
- **Per-user state isolated:** read/unread and archived live on the recipient row, unique per `(notification, user)`.

## Deep links (the one subtlety)

Today `href` is derived **per recipient** as `/(role)/notifications/offers/{id}` —
the role segment differs per user, so it cannot live on a shared content row.

**Resolution:** `notifications.href` holds only an explicit override. The full
deep link is **computed at read time** in the feed/detail endpoints, where the
server knows the requesting user's role (`detailHref(user.role, type, notification_id)`).
Push notifications already compute href per-user at send time (push payloads are
not stored), so that path is unchanged. The app keeps receiving a ready-to-use
`href`; it's just computed on read instead of stored per row.

## API (blink-server)

Response shape stays **flattened** so the mobile store/UI barely change — each
feed item is `{ id: notification_id, type, title, description, payload,
content_*, href, is_unread, created_at }`.

| method / path | behaviour |
|---|---|
| `GET /notifications?filter=active` (default) | recipients JOIN notifications, `user_id = me AND archived_at IS NULL`, newest first, paginated; compute `href` |
| `GET /notifications?filter=archived` | same but `archived_at IS NOT NULL` — the **archive view** |
| `GET /notifications/:id` | by notification id; 404 unless a recipient row exists for me |
| `PATCH /notifications/:id/read` | set my recipient `is_unread = false` |
| `PATCH /notifications/read-all` | set all my recipients `is_unread = false` |
| `DELETE /notifications/:id` | **archive** — set my recipient `archived_at = now()` (verb kept for app compat; semantics = archive) |
| `POST /notifications/:id/restore` | clear my recipient `archived_at` (un-archive / "see it again") |

`:id` is always the **shared `notification_id`**; every endpoint scopes to the
caller via the recipient join.

### `lib/notifications.ts`

- `createNotification(input)` → insert **1** `notifications` row + **1**
  `notification_recipients` row for `input.userId`; push per the user's devices.
  Drop the stored-href derivation/UPDATE dance (href computed on read).
- `broadcastNotification(roles, input)` → insert **1** `notifications` row, fetch
  users in `roles`, **bulk-insert N recipient rows**, push per user. Returns
  recipient count. Records `target_roles` + `created_by`.

## Dashboard (blink-dashboard)

- `sendCampaign` → 1 `notifications` row (content + `target_roles` + `created_by`)
  then bulk-insert `notification_recipients` for users in the roles; push as today.
- Campaign list "reach"/"opens" become COUNTs over `notification_recipients`
  (`reach = count`, `opens = count where is_unread = false`).
- Update the feature's local row types to match (no shared schema package).

## Mobile (blink)

- `lib/api/notifications.ts` / `store/notification-store.ts`: feed shape is
  unchanged; add an **archive list** (`filter=archived`) and a **restore** call.
  Existing "delete" already maps to `DELETE /:id`, now archive semantics.
- Add an Archive screen/section in the notifications UI (lists archived, with a
  restore action). i18n keys in en/fr/ar.

## Migration `00019_notification_recipients.sql`

1. `CREATE TABLE notification_recipients (...)` + indexes + RLS + (no updated_at).
2. **Backfill** one recipient per existing notification:
   `INSERT INTO notification_recipients (notification_id, user_id, is_unread, archived_at, created_at)
    SELECT id, user_id, is_unread, deleted_at, created_at FROM notifications WHERE user_id IS NOT NULL;`
   (old `deleted_at` maps to `archived_at`).
3. `ALTER TABLE notifications` — drop `user_id`, `is_unread`, `deleted_at` and
   their indexes/policies (`idx_notifications_user`, `idx_notifications_unread`,
   `idx_notifications_user_active`, `notifications_select_own`,
   `notifications_update_own`); add `target_roles text[]`, `created_by uuid`.
4. New `notifications` RLS: `select` where `EXISTS (recipient for auth.uid())`.

**Historical broadcasts stay content-duplicated** — past fan-out rows each become
one notification + one recipient. Only new sends dedupe. (Regrouping old rows is
unreliable and not worth it.)

## Out of scope

- Email/SMS delivery channels (already unbuilt).
- Auto-purging archived notifications after a retention window (could be a future
  cron; not now).
- Regrouping historical duplicated broadcasts.

## Rollout order

1. blink-server: schema + migration (push to shared Supabase) → `lib/notifications.ts` → routes.
2. blink-dashboard: `sendCampaign` + analytics + types.
3. blink: archive UI + restore + i18n.
4. Deploy server (`npm run deploy`).
