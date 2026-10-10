-- Rides (passenger moto-taxi) — what the rider needs, and who may cancel.
-- Additive, except canceled_by's check, which is widened (never narrowed), and
-- the users guard function, replaced with one more rule (rider gender).
-- Needs 20261009230356_ride_enums.sql (and 20261009230346_courier_details.sql
-- for cancel_reason / cancel_note / rider_rating, reused by rides).
-- Spec: blink/docs/superpowers/specs/2026-10-09-ride-requests-design.md
--
--   ride          ride orders only (type = 'ride'):
--                 { pickup {label,address,lat,lng,note}, destination {label,address,lat,lng},
--                   passenger {name,phone} | null (null = the customer rides),
--                   distance_km, duration_minutes, female_rider_only,
--                   arrived_at (the rider reached the pickup) }
--                 Shape validated by the API (src/validators/ride.ts). The flat
--                 pickup_* / destination_* columns mirror the two points.
--   canceled_by   += 'rider': the rider waited at the pickup and the passenger
--                 never came (cancel_reason 'passenger_no_show').
--   users guard   a rider's gender can't change once set (female_rider_only
--                 relies on it) — see the end of this file.

alter table public.orders
  add column if not exists ride jsonb;

-- The search-timeouts cron scans unclaimed rides.
create index if not exists idx_orders_ride_searching
  on public.orders (created_at)
  where type = 'ride' and status = 'searching' and rider_id is null;

-- 00036_merchant_flows.sql created canceled_by's check inline (unnamed): drop
-- whichever check constraint covers the column, then add the wider one.
do $$
declare
  c text;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.orders'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%canceled_by%'
  loop
    execute format('alter table public.orders drop constraint %I', c);
  end loop;
end $$;

alter table public.orders
  add constraint orders_canceled_by_check
  check (canceled_by in ('customer', 'merchant', 'system', 'rider'));

-- ─── A rider's gender is fixed once set ──────────────────────────────
-- female_rider_only offers a ride only to riders with users.gender = 'female'.
-- gender is a display field the user may edit (granted to authenticated in
-- 20261006215408_users_privileged_columns.sql, and written by the server's
-- PATCH /auth/profile with the service role), so a male rider could flip it to
-- get those rides. There is no verified gender (no KYC column), so: a rider —
-- role 'rider' before or after the write, or anyone with a rider_profiles row
-- (POST /auth/role switches roles freely) — may set gender once (NULL → value,
-- e.g. their first profile save) but never change it. Applies to the API's
-- service role too; only a database admin (postgres / supabase_admin, SQL
-- editor) can correct it.
--
-- CREATE OR REPLACE of the guard from 20261006215408_users_privileged_columns.sql:
-- its client-role rule is kept exactly as it was; the gender rule is added.
create or replace function public.guard_users_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.id is distinct from old.id
    or new.role is distinct from old.role
    or new.staff_role is distinct from old.staff_role
    or new.pin_hash is distinct from old.pin_hash
    or new.bank_rib is distinct from old.bank_rib
    or new.phone_number is distinct from old.phone_number
    or new.email is distinct from old.email
  ) then
    raise exception 'permission denied: privileged users column' using errcode = '42501';
  end if;

  if current_user not in ('postgres', 'supabase_admin')
     and old.gender is not null
     and new.gender is distinct from old.gender
     and (
          old.role = 'rider'
       or new.role = 'rider'
       or exists (select 1 from public.rider_profiles rp where rp.user_id = old.id)
     ) then
    raise exception 'permission denied: a rider''s gender can''t be changed once set' using errcode = '42501';
  end if;
  return new;
end;
$$;
