-- (Applied with psql on 2026-10-10 and recorded as version 20261010232025 in
-- supabase_migrations.schema_migrations; the filename matches so
-- `supabase db push` sees local == remote.)
--
-- Partner piece 1 (security): no client-side self-approval on the partner
-- verification tables.
--
-- Audit (2026-10-10, information_schema.column_privileges, online project):
-- anon + authenticated held table-wide INSERT / UPDATE / DELETE on vehicles,
-- agent_shops and agent_profiles — every column — and the owner policies
-- (vehicles_all_own and agent_shops_update_own in 00001_initial_schema.sql,
-- agent_profiles_update_own in 00011_agent_profiles.sql) let an owner write
-- their own row through PostgREST:
--   agent_shops.review_status       an agent could approve their own shop
--   agent_shops.documents / rating  …and edit its review documents / rating
--   agent_profiles.documents        mark their own business documents verified
--   vehicles.*_status               a rider could verify their own papers
--
-- merchant_profiles (merchant_profiles_update_own, 00018_merchant_customer_profiles.sql)
-- had the same open grant. It has no review column (only the display ID
-- merchant_id), so it gets the revoke without a guard trigger.
--
-- No client writes these tables directly: the app goes through blink-server
-- (service role) and the dashboard only reads agent_shops and embeds
-- merchant_profiles in a select. So, as
-- 20261006215408_users_privileged_columns.sql did for users, writes become
-- service-role only, and one guard trigger per review table rejects client
-- changes to the review columns even if a broad GRANT is re-added later.
-- Reads (the select policies) are unchanged.
--
-- blink-dashboard writes agent_profiles.documents and vehicles in
-- src/app/d/deletion-requests/action.ts through the SERVICE-ROLE client, which
-- bypasses grants and RLS (unaffected).
--
-- Beyond the revoke, the owner write policies are dropped too, so a re-added
-- broad GRANT alone could not reopen the hole. Every table keeps an owner
-- SELECT policy (vehicles_select_own, agent_shops_select_all,
-- agent_profiles_select_own, merchant_profiles_select_own); vehicles_all_own was
-- FOR ALL but vehicles_select_own is separate, so owners keep read access.

revoke insert, update, delete, truncate on public.vehicles          from anon, authenticated;
revoke insert, update, delete, truncate on public.agent_shops       from anon, authenticated;
revoke insert, update, delete, truncate on public.agent_profiles    from anon, authenticated;
revoke insert, update, delete, truncate on public.merchant_profiles from anon, authenticated;

drop policy if exists vehicles_all_own on public.vehicles;
drop policy if exists agent_shops_update_own on public.agent_shops;
drop policy if exists agent_profiles_update_own on public.agent_profiles;
drop policy if exists merchant_profiles_update_own on public.merchant_profiles;

create or replace function public.guard_agent_shops_review_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.user_id       is distinct from old.user_id
    or new.review_status is distinct from old.review_status
    or new.documents     is distinct from old.documents
    or new.rating        is distinct from old.rating
  ) then
    raise exception 'permission denied: agent_shops review column' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger trg_agent_shops_guard_review
  before update on public.agent_shops
  for each row execute function public.guard_agent_shops_review_columns();

create or replace function public.guard_agent_profiles_documents()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.user_id   is distinct from old.user_id
    or new.agent_id  is distinct from old.agent_id
    or new.documents is distinct from old.documents
  ) then
    raise exception 'permission denied: agent_profiles review column' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger trg_agent_profiles_guard_documents
  before update on public.agent_profiles
  for each row execute function public.guard_agent_profiles_documents();

create or replace function public.guard_vehicles_document_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.user_id                is distinct from old.user_id
    or new.gray_card_status       is distinct from old.gray_card_status
    or new.insurance_status       is distinct from old.insurance_status
    or new.driving_license_status is distinct from old.driving_license_status
  ) then
    raise exception 'permission denied: vehicles review column' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger trg_vehicles_guard_status
  before update on public.vehicles
  for each row execute function public.guard_vehicles_document_status();
