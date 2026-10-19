-- Pricing config (Phase 1): every fee/rate Blink earns from becomes a row,
-- with scoped + dated overrides, a change log, and per-order/per-transaction
-- rate snapshots (so editing a rate never rewrites past dues).
-- Spec: blink/docs/superpowers/specs/2026-10-18-pricing-config-design.md
-- RLS is enabled with NO policies: service-role only (server + console).
-- Seeds = today's constants, so applying this changes no price.

create table if not exists public.pricing_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pricing_overrides (
  id uuid primary key default gen_random_uuid(),
  key text not null references public.pricing_settings(key),
  service text,
  wilaya_code text,
  merchant_id uuid references public.users(id) on delete cascade,
  agent_id uuid references public.users(id) on delete cascade,
  value jsonb not null,
  starts_at timestamptz,
  ends_at timestamptz,
  note text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_overrides_one_partner check (merchant_id is null or agent_id is null),
  constraint pricing_overrides_window check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index if not exists idx_pricing_overrides_key on public.pricing_overrides (key) where archived_at is null;

create table if not exists public.pricing_changes (
  id uuid primary key default gen_random_uuid(),
  key text not null,
  override_id uuid,
  action text not null check (action in ('update_default', 'create_override', 'update_override', 'archive_override')),
  before jsonb,
  after jsonb,
  actor_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_pricing_changes_key on public.pricing_changes (key, created_at);
create index if not exists idx_pricing_changes_override on public.pricing_changes (override_id) where override_id is not null;

alter table public.pricing_settings enable row level security;
alter table public.pricing_overrides enable row level security;
alter table public.pricing_changes enable row level security;

-- updated_at auto-bump (update_updated_at() from the baseline migration).
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'pricing_settings_updated_at') then
    create trigger pricing_settings_updated_at before update on public.pricing_settings
      for each row execute function update_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pricing_overrides_updated_at') then
    create trigger pricing_overrides_updated_at before update on public.pricing_overrides
      for each row execute function update_updated_at();
  end if;
end $$;

-- Seeds: today's constants (lib/service-fee.ts, courier-pricing.ts, ride-pricing.ts,
-- cash-jobs.ts, dispatch.ts, merchant/shared.ts, agent-finance.ts, transactions routes).
insert into public.pricing_settings (key, value) values
  ('service_fee', '{"amount": 1.5}'),
  ('courier_fare', '{"bicycle": {"base": 140, "included_km": 2, "per_km": 35, "max_km": 10}, "motorcycle": {"base": 250, "included_km": 3, "per_km": 40, "max_km": 40}, "extra_stop_fee": 60}'),
  ('ride_fare', '{"motorcycle": {"base": 200, "included_km": 3, "per_km": 40, "max_km": 40}}'),
  ('fare_multiplier', '{"multiplier": 1}'),
  ('rider_commission_rate', '{"rate": 0.15}'),
  ('merchant_commission_rate', '{"rate": 0.05}'),
  ('blink_cash_fee_rate', '{"rate": 0.02}'),
  ('agent_platform_share', '{"rate": 0.2}'),
  ('rider_cancel_penalty', '{"amount": 200}'),
  ('stamp_duty_rate', '{"rate": 0.01}'),
  ('agent_tax_rate', '{"rate": 0.01}'),
  ('dues_payment_fee_rate', '{"rate": 0.002}')
on conflict (key) do nothing;

-- Rate snapshots.
alter table public.orders add column if not exists merchant_commission_rate numeric(6, 4);
alter table public.orders add column if not exists stamp_duty_rate numeric(6, 4);
alter table public.orders add column if not exists pricing_applied jsonb;

alter table public.transactions add column if not exists fee_rate numeric(6, 4);
alter table public.transactions add column if not exists platform_share_rate numeric(6, 4);
alter table public.transactions add column if not exists tax_rate numeric(6, 4);

-- Backfill: the rates that were hard-coded until now.
update public.orders
   set merchant_commission_rate = 0.05, stamp_duty_rate = 0.01
 where store_id is not null and merchant_commission_rate is null;

update public.transactions
   set fee_rate = 0.02, platform_share_rate = 0.20, tax_rate = 0.01
 where fee_rate is null;

-- Trips fix the commission rate they were created under (bundle completion
-- must not re-price it).
alter table public.trips add column if not exists commission_rate numeric(6, 4);
update public.trips set commission_rate = 0.15 where commission_rate is null;

-- Overlap guard in the DB (the app-level check can't see a concurrent insert):
-- same key + identical scope + overlapping window, live rows only.
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pricing_overrides_no_overlap') then
    alter table public.pricing_overrides
      add constraint pricing_overrides_no_overlap exclude using gist (
        key with =,
        (coalesce(service, '')) with =,
        (coalesce(wilaya_code, '')) with =,
        (coalesce(merchant_id::text, '')) with =,
        (coalesce(agent_id::text, '')) with =,
        (tstzrange(coalesce(starts_at, '-infinity'::timestamptz), coalesce(ends_at, 'infinity'::timestamptz))) with &&
      ) where (archived_at is null);
  end if;
end $$;

-- Atomic audit log: the change row is written in the same transaction as the
-- write, attributed to updated_by / created_by (the routes always set them).
create or replace function public.pricing_log_setting_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.pricing_changes (key, override_id, action, before, after, actor_id)
  values (
    new.key,
    null,
    'update_default',
    case when tg_op = 'UPDATE' then old.value else null end,
    new.value,
    new.updated_by
  );
  return null;
end $$;

create or replace function public.pricing_log_override_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_changes (key, override_id, action, before, after, actor_id)
    values (new.key, new.id, 'create_override', null, to_jsonb(new), coalesce(new.created_by, new.updated_by));
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.pricing_changes (key, override_id, action, before, after, actor_id)
    values (new.key, new.id, 'archive_override', to_jsonb(old), to_jsonb(new), new.updated_by);
  else
    insert into public.pricing_changes (key, override_id, action, before, after, actor_id)
    values (new.key, new.id, 'update_override', to_jsonb(old), to_jsonb(new), new.updated_by);
  end if;
  return null;
end $$;

drop trigger if exists pricing_settings_audit on public.pricing_settings;
create trigger pricing_settings_audit after insert or update on public.pricing_settings
  for each row execute function public.pricing_log_setting_change();

drop trigger if exists pricing_overrides_audit on public.pricing_overrides;
create trigger pricing_overrides_audit after insert or update on public.pricing_overrides
  for each row execute function public.pricing_log_override_change();
