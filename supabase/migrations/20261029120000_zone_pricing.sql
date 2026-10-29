-- Zone pricing: tiers (urban / town / rural, staff-extensible), polygons drawn
-- on the dashboard map, zone/tier scopes on overrides, the configurable fare
-- formula + drop-off surcharge + service-area keys, and the pricing place
-- stored on every order.
-- Spec: blink/docs/superpowers/specs/2026-10-29-zone-pricing-design.md
-- RLS is enabled with NO policies: service-role only (server + console).
-- Seeds reproduce today's prices exactly: every tier resolves to the defaults
-- until staff set tier / zone overrides. Idempotent (re-runnable).

-- ─── Tiers ───────────────────────────────────────────────────────────
create table if not exists public.pricing_tiers (
  code text primary key,
  names jsonb not null,
  color text not null,
  sort_order integer not null default 0,
  note text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_tiers_code check (code ~ '^[a-z][a-z0-9_]{1,23}$'),
  constraint pricing_tiers_color check (color ~ '^#[0-9A-Fa-f]{6}$')
);

insert into public.pricing_tiers (code, names, color, sort_order) values
  ('urban', '{"en": "Urban", "fr": "Urbain", "ar": "حضري"}', '#2563EB', 1),
  ('town', '{"en": "Town", "fr": "Ville moyenne", "ar": "بلدة"}', '#16A34A', 2),
  ('rural', '{"en": "Rural", "fr": "Rural", "ar": "ريفي"}', '#D97706', 3)
on conflict (code) do nothing;

-- ─── Zones ───────────────────────────────────────────────────────────
-- geometry: GeoJSON Polygon | MultiPolygon in [lng, lat], validated by the
-- server (closed rings, inside Algeria's bbox, ≤ 5 000 vertices).
create table if not exists public.pricing_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tier text not null references public.pricing_tiers(code),
  wilaya_code text,
  geometry jsonb not null,
  priority integer not null default 0,
  note text,
  created_by uuid references public.users(id) on delete set null,
  updated_by uuid references public.users(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pricing_zones_name check (char_length(name) between 1 and 80)
);

create index if not exists idx_pricing_zones_live on public.pricing_zones (tier) where archived_at is null;

alter table public.pricing_tiers enable row level security;
alter table public.pricing_zones enable row level security;

-- ─── Overrides: zone + tier scopes ───────────────────────────────────
alter table public.pricing_overrides add column if not exists zone_id uuid references public.pricing_zones(id);
alter table public.pricing_overrides add column if not exists tier text references public.pricing_tiers(code);

do $$
begin
  -- A zone already implies its wilaya and tier.
  if not exists (select 1 from pg_constraint where conname = 'pricing_overrides_zone_scope') then
    alter table public.pricing_overrides
      add constraint pricing_overrides_zone_scope check (zone_id is null or (tier is null and wilaya_code is null));
  end if;

  -- The overlap guard learns the two new scope columns: drop the Phase 1
  -- constraint (it doesn't mention zone_id) and recreate it.
  if exists (
    select 1 from pg_constraint
     where conname = 'pricing_overrides_no_overlap'
       and pg_get_constraintdef(oid) not like '%zone_id%'
  ) then
    alter table public.pricing_overrides drop constraint pricing_overrides_no_overlap;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pricing_overrides_no_overlap') then
    alter table public.pricing_overrides
      add constraint pricing_overrides_no_overlap exclude using gist (
        key with =,
        (coalesce(service, '')) with =,
        (coalesce(wilaya_code, '')) with =,
        (coalesce(merchant_id::text, '')) with =,
        (coalesce(agent_id::text, '')) with =,
        (coalesce(zone_id::text, '')) with =,
        (coalesce(tier, '')) with =,
        (tstzrange(coalesce(starts_at, '-infinity'::timestamptz), coalesce(ends_at, 'infinity'::timestamptz))) with &&
      ) where (archived_at is null);
  end if;
end $$;

create index if not exists idx_pricing_overrides_zone on public.pricing_overrides (zone_id) where zone_id is not null and archived_at is null;
create index if not exists idx_pricing_overrides_tier on public.pricing_overrides (tier) where tier is not null and archived_at is null;

-- ─── Change log: zone + tier writes ──────────────────────────────────
alter table public.pricing_changes add column if not exists zone_id uuid;
alter table public.pricing_changes add column if not exists tier text;

alter table public.pricing_changes drop constraint if exists pricing_changes_action_check;
alter table public.pricing_changes
  add constraint pricing_changes_action_check check (action in (
    'update_default', 'create_override', 'update_override', 'archive_override',
    'create_zone', 'update_zone', 'archive_zone',
    'create_tier', 'update_tier', 'archive_tier'
  ));

create index if not exists idx_pricing_changes_zone on public.pricing_changes (zone_id, created_at) where zone_id is not null;
create index if not exists idx_pricing_changes_tier on public.pricing_changes (tier, created_at) where tier is not null;

-- updated_at auto-bump (update_updated_at() from the baseline migration).
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'pricing_tiers_updated_at') then
    create trigger pricing_tiers_updated_at before update on public.pricing_tiers
      for each row execute function update_updated_at();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'pricing_zones_updated_at') then
    create trigger pricing_zones_updated_at before update on public.pricing_zones
      for each row execute function update_updated_at();
  end if;
end $$;

-- Atomic audit log, same pattern as overrides: the row is written in the same
-- transaction as the write, attributed to updated_by / created_by (the routes
-- always set them). Geometry is left out of the log (it can be large); an
-- update records whether it changed.
create or replace function public.pricing_log_override_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_changes (key, override_id, zone_id, tier, action, before, after, actor_id)
    values (new.key, new.id, new.zone_id, new.tier, 'create_override', null, to_jsonb(new), coalesce(new.created_by, new.updated_by));
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.pricing_changes (key, override_id, zone_id, tier, action, before, after, actor_id)
    values (new.key, new.id, new.zone_id, new.tier, 'archive_override', to_jsonb(old), to_jsonb(new), new.updated_by);
  else
    insert into public.pricing_changes (key, override_id, zone_id, tier, action, before, after, actor_id)
    values (new.key, new.id, new.zone_id, new.tier, 'update_override', to_jsonb(old), to_jsonb(new), new.updated_by);
  end if;
  return null;
end $$;

create or replace function public.pricing_log_zone_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_changes (key, zone_id, action, before, after, actor_id)
    values ('pricing_zone', new.id, 'create_zone', null, to_jsonb(new) - 'geometry', coalesce(new.created_by, new.updated_by));
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.pricing_changes (key, zone_id, action, before, after, actor_id)
    values ('pricing_zone', new.id, 'archive_zone', to_jsonb(old) - 'geometry', to_jsonb(new) - 'geometry', new.updated_by);
  else
    insert into public.pricing_changes (key, zone_id, action, before, after, actor_id)
    values (
      'pricing_zone', new.id, 'update_zone',
      to_jsonb(old) - 'geometry',
      (to_jsonb(new) - 'geometry') || jsonb_build_object('geometry_changed', old.geometry is distinct from new.geometry),
      new.updated_by
    );
  end if;
  return null;
end $$;

create or replace function public.pricing_log_tier_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.pricing_changes (key, tier, action, before, after, actor_id)
    values ('pricing_tier', new.code, 'create_tier', null, to_jsonb(new), coalesce(new.created_by, new.updated_by));
  elsif old.archived_at is null and new.archived_at is not null then
    insert into public.pricing_changes (key, tier, action, before, after, actor_id)
    values ('pricing_tier', new.code, 'archive_tier', to_jsonb(old), to_jsonb(new), new.updated_by);
  else
    insert into public.pricing_changes (key, tier, action, before, after, actor_id)
    values ('pricing_tier', new.code, 'update_tier', to_jsonb(old), to_jsonb(new), new.updated_by);
  end if;
  return null;
end $$;

drop trigger if exists pricing_zones_audit on public.pricing_zones;
create trigger pricing_zones_audit after insert or update on public.pricing_zones
  for each row execute function public.pricing_log_zone_change();

drop trigger if exists pricing_tiers_audit on public.pricing_tiers;
create trigger pricing_tiers_audit after insert or update on public.pricing_tiers
  for each row execute function public.pricing_log_tier_change();

-- ─── Orders: the pricing place ───────────────────────────────────────
alter table public.orders add column if not exists pricing_zone_id uuid references public.pricing_zones(id) on delete set null;
alter table public.orders add column if not exists pricing_tier text;

-- ─── Seeds: the 4 new keys ───────────────────────────────────────────
-- courier_fare / ride_fare keep their stored value: the server defaults the
-- new per_minute to 0 when a stored leg has none.
insert into public.pricing_settings (key, value) values
  ('fare_formula', '{"road_factor": 1.3, "rounding_step": 10, "rounding_mode": "up", "min_fare": 0, "max_fare": 0, "min_ride_km": 0.3, "speed_kmh": {"bicycle": 14, "motorcycle": 28}, "stop_minutes": 3, "boarding_minutes": 2}'),
  ('dropoff_surcharge', '{"amount": 0, "only_when_tier_changes": true}'),
  ('service_area', '{"enabled": true}'),
  ('zone_defaults', '{"unzoned_tier": "rural"}')
on conflict (key) do nothing;
