-- Real-time notification feed sync across roles.
-- (Applied via the Supabase MCP as migration `notification_realtime`. Rename
-- this file to `<recorded version>_notification_realtime.sql` — the version
-- `list_migrations` shows — so `supabase db push` sees local == remote. Until
-- then the CLI skips it: the name doesn't match `<version>_<name>.sql`.)
--
-- Any write to notification_recipients (new notification / broadcast fan-out,
-- read, read-all, archive, restore) is announced on the PRIVATE per-user topic
-- `user:<uuid>` (event `notification_changed`) that the app already joins for
-- order/trip sync. The `blink_receive_own_topics` policy on realtime.messages
-- already restricts each user to their own topic.
--
-- Statement-level with transition tables: one event per affected user per
-- statement, so read-all (N rows, one user) sends 1 message and a broadcast
-- fan-out sends 1 per recipient. Postgres forbids transition tables on
-- multi-event triggers, hence one trigger per event. Payload carries no content
-- (clients refetch through the API); realtime.send swallows its own errors, so
-- a broadcast failure never aborts the write.

create or replace function public.broadcast_notification_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
begin
  for uid in select distinct c.user_id from changed c where c.user_id is not null loop
    perform realtime.send(
      jsonb_build_object('table', 'notification_recipients', 'op', lower(tg_op)),
      'notification_changed', 'user:' || uid::text, true
    );
  end loop;
  return null;
end;
$$;

create or replace trigger trg_notification_recipients_broadcast_ins
  after insert on public.notification_recipients
  referencing new table as changed
  for each statement execute function public.broadcast_notification_change();

create or replace trigger trg_notification_recipients_broadcast_upd
  after update on public.notification_recipients
  referencing new table as changed
  for each statement execute function public.broadcast_notification_change();

create or replace trigger trg_notification_recipients_broadcast_del
  after delete on public.notification_recipients
  referencing old table as changed
  for each statement execute function public.broadcast_notification_change();
