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
