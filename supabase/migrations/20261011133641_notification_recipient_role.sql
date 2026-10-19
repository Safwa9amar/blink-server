-- Multi-role accounts: one notification feed per role.
--
-- An account holding several roles (one users row, one phone number) used to
-- see every role's notifications in one feed: notification_recipients was keyed
-- by (notification_id, user_id) only. A recipient row now names the ONE role
-- whose feed it belongs to; the API reads, counts and marks rows of the
-- caller's active role (users.role) only. A broadcast to several roles lands
-- once in each targeted feed the account holds, each with its own read/archive
-- state.

alter table public.notification_recipients
  add column if not exists role public.user_role;

-- Backfill: the role group the notification's deep link opens in
-- ("/(merchant)/orders" → merchant), else the account's active role (accounts
-- were single-role until granted_roles, so that is the role it was sent to).
update public.notification_recipients nr
set role = coalesce(
  substring(n.href from '^/\((customer|rider|merchant|agent)\)')::public.user_role,
  u.role
)
from public.notifications n, public.users u
where nr.notification_id = n.id
  and nr.user_id = u.id
  and nr.role is null;

alter table public.notification_recipients
  alter column role set not null;

alter table public.notification_recipients
  drop constraint if exists notification_recipients_pkey;
alter table public.notification_recipients
  add primary key (notification_id, user_id, role);

-- Writers that don't name the role yet (a server or dashboard deployed before
-- this change) still insert: the row lands in the feed its deep link opens in,
-- else the recipient's active role (what they saw before).
create or replace function public.notification_recipient_default_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role is null then
    new.role := coalesce(
      (select substring(n.href from '^/\((customer|rider|merchant|agent)\)')::public.user_role
       from public.notifications n where n.id = new.notification_id),
      (select u.role from public.users u where u.id = new.user_id)
    );
  end if;
  return new;
end;
$$;

create or replace trigger trg_notification_recipients_default_role
  before insert on public.notification_recipients
  for each row execute function public.notification_recipient_default_role();

-- Feed reads and the unread badge are per user AND role now.
drop index if exists public.idx_notification_recipients_user;
drop index if exists public.idx_notification_recipients_unread;
create index idx_notification_recipients_user
  on public.notification_recipients (user_id, role, archived_at);
create index idx_notification_recipients_unread
  on public.notification_recipients (user_id, role)
  where is_unread = true;
