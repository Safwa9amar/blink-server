-- Staff access audit trail for the dashboard's Access module.
--
-- One row per change to a console account: created, granted, role_changed,
-- revoked, suspended, reinstated, password_reset (by a super_admin) and
-- password_changed (by the staff member). Written and read only by the
-- dashboard's service-role client; RLS on with no client policies.

create table if not exists public.staff_access_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users(id) on delete set null,
  target_id uuid references public.users(id) on delete set null,
  action text not null check (action in (
    'created', 'granted', 'role_changed', 'revoked',
    'suspended', 'reinstated', 'password_reset', 'password_changed'
  )),
  from_role public.staff_role,
  to_role public.staff_role,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_staff_access_events_created
  on public.staff_access_events (created_at desc);
create index if not exists idx_staff_access_events_target
  on public.staff_access_events (target_id, created_at desc);

alter table public.staff_access_events enable row level security;
