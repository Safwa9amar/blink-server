-- Support desk: ticket priority, CSAT, canned-reply macros, SLA policies.
--
-- support_conversations: priority (low|normal|high|urgent) + CSAT columns.
--   RLS on this table is SELECT-only (00023: owner + staff) and there are no
--   column grants to widen it, so end users cannot write priority/csat_*
--   directly; all writes go through the server (service role).
-- support_macros / support_sla_policies: service-role only (RLS on, no
--   policies). The dashboard reads/writes them via the admin client.

alter table public.support_conversations add column if not exists priority text not null default 'normal';
alter table public.support_conversations add column if not exists csat_rating smallint;
alter table public.support_conversations add column if not exists csat_comment text;
alter table public.support_conversations add column if not exists csat_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'support_conversations_priority_check') then
    alter table public.support_conversations
      add constraint support_conversations_priority_check
      check (priority in ('low', 'normal', 'high', 'urgent'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'support_conversations_csat_rating_check') then
    alter table public.support_conversations
      add constraint support_conversations_csat_rating_check
      check (csat_rating is null or csat_rating between 1 and 5);
  end if;
end $$;

create index if not exists idx_support_conversations_priority on public.support_conversations (priority);

create table if not exists public.support_macros (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  locale text check (locale is null or locale in ('en', 'fr', 'ar')),
  target_role public.user_role,
  uses integer not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.support_macros enable row level security;

create table if not exists public.support_sla_policies (
  priority text primary key check (priority in ('low', 'normal', 'high', 'urgent')),
  first_response_minutes integer not null check (first_response_minutes > 0),
  resolution_minutes integer not null check (resolution_minutes > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.users(id) on delete set null
);
alter table public.support_sla_policies enable row level security;

insert into public.support_sla_policies (priority, first_response_minutes, resolution_minutes) values
  ('urgent', 5, 120),
  ('high', 15, 480),
  ('normal', 60, 1440),
  ('low', 240, 4320)
on conflict (priority) do nothing;
