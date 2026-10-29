-- Vehicle classes (Bicycle / Moto / Moto Comfort …): staff-defined products that
-- fares are priced and jobs matched by, a rider's assigned class, and the
-- `store_delivery` pricing key (marketplace delivery by zone / distance).
-- Spec: blink/docs/superpowers/specs/2026-10-29-zone-pricing-design.md (Addenda 1 + 2)
-- RLS is enabled with NO policies: service-role only (server + console).
-- Seeds keep today's prices: motorcycle_comfort is seeded DISABLED and
-- store_delivery is merchant mode with no clamp. Idempotent (re-runnable).

create table if not exists public.vehicle_classes (
  code text primary key,
  names jsonb not null,
  base_vehicle text not null,
  services text[] not null,
  exclusive boolean not null default false,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  note text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vehicle_classes_code check (code ~ '^[a-z][a-z0-9_]{1,23}$'),
  constraint vehicle_classes_base check (base_vehicle in ('bicycle', 'motorcycle')),
  constraint vehicle_classes_services check (services <@ array['ride', 'courier', 'store']::text[])
);

alter table public.vehicle_classes enable row level security;

insert into public.vehicle_classes (code, names, base_vehicle, services, exclusive, enabled, sort_order) values
  ('bicycle', '{"en": "Bicycle", "fr": "Vélo", "ar": "دراجة"}', 'bicycle', array['courier', 'store'], false, true, 1),
  ('motorcycle', '{"en": "Moto", "fr": "Moto", "ar": "دراجة نارية"}', 'motorcycle', array['ride', 'courier', 'store'], false, true, 2),
  ('motorcycle_comfort', '{"en": "Moto Comfort", "fr": "Moto Confort", "ar": "دراجة نارية مريحة"}', 'motorcycle', array['ride'], true, false, 3)
on conflict (code) do nothing;

-- A rider's assigned class (null = the default class of rider_profiles.vehicle_type).
alter table public.rider_profiles add column if not exists vehicle_class text references public.vehicle_classes(code);
create index if not exists idx_rider_profiles_vehicle_class on public.rider_profiles (vehicle_class) where vehicle_class is not null;

-- updated_at auto-bump (update_updated_at() from the baseline migration).
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'vehicle_classes_updated_at') then
    create trigger vehicle_classes_updated_at before update on public.vehicle_classes
      for each row execute function update_updated_at();
  end if;
end $$;

-- Change log: the vehicle_class column and the three actions.
alter table public.pricing_changes add column if not exists vehicle_class text;
alter table public.pricing_changes drop constraint if exists pricing_changes_action_check;
alter table public.pricing_changes
  add constraint pricing_changes_action_check check (action in (
    'update_default', 'create_override', 'update_override', 'archive_override',
    'create_zone', 'update_zone', 'archive_zone',
    'create_tier', 'update_tier', 'archive_tier',
    'create_vehicle_class', 'update_vehicle_class', 'archive_vehicle_class'
  ));
create index if not exists idx_pricing_changes_vehicle_class on public.pricing_changes (vehicle_class, created_at) where vehicle_class is not null;

-- Atomic audit log, same pattern as tiers: written in the write's transaction,
-- attributed to updated_by / created_by (the routes always set them).
create or replace function public.pricing_log_vehicle_class_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_changes (key, vehicle_class, action, before, after, actor_id)
    values ('vehicle_class', new.code, 'create_vehicle_class', null, to_jsonb(new), coalesce(new.created_by, new.updated_by));
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.pricing_changes (key, vehicle_class, action, before, after, actor_id)
    values ('vehicle_class', new.code, 'archive_vehicle_class', to_jsonb(old), to_jsonb(new), new.updated_by);
  else
    insert into public.pricing_changes (key, vehicle_class, action, before, after, actor_id)
    values ('vehicle_class', new.code, 'update_vehicle_class', to_jsonb(old), to_jsonb(new), new.updated_by);
  end if;
  return null;
end $$;

drop trigger if exists vehicle_classes_audit on public.vehicle_classes;
create trigger vehicle_classes_audit after insert or update on public.vehicle_classes
  for each row execute function public.pricing_log_vehicle_class_change();
-- (Seed rows above are inserted before the audit trigger exists on a first run: no log noise.)

-- ─── Seed: store_delivery ────────────────────────────────────────────
-- Merchant mode, no clamp: every store keeps charging its own fee. courier_fare
-- and ride_fare keep their stored value ({bicycle, motorcycle, extra_stop_fee} /
-- {motorcycle}); a class without a stored leg falls back to the code seed.
insert into public.pricing_settings (key, value) values
  ('store_delivery', '{"mode": "merchant", "min_fee": 0, "max_fee": 0, "bicycle": {"base": 140, "included_km": 2, "per_km": 35, "max_km": 10, "per_minute": 0}, "motorcycle": {"base": 250, "included_km": 3, "per_km": 40, "max_km": 40, "per_minute": 0}}')
on conflict (key) do nothing;
