-- SMS channel for scheduled broadcasts (Drizzle: src/db/schema/scheduled-notifications.ts).
--
-- The dashboard composer's "SMS" channel used to be recorded but never sent.
-- A scheduled row with "sms" in `channels` is now texted by the cron through
-- SMS Gate (lib/notification-sms.ts) in `sms_lang`; `sms_sent` is how many
-- numbers the gateway accepted. Additive only.

alter table public.scheduled_notifications
  add column if not exists sms_lang text,
  add column if not exists sms_sent integer not null default 0;

alter table public.scheduled_notifications
  drop constraint if exists scheduled_notifications_sms_lang_check;
alter table public.scheduled_notifications
  add constraint scheduled_notifications_sms_lang_check
  check (sms_lang is null or sms_lang in ('en', 'fr', 'ar'));
