-- Multi-role accounts (Become a Partner, piece 2).
--
-- users.role stays the ACTIVE role (requireRole, RLS and realtime keep reading
-- it). users.granted_roles lists every role unlocked on the account. Every
-- account always holds customer and its active role (trigger below).
-- Roles are NOT inferred from existing profile rows: the old self-serve
-- POST /auth/role may have created bogus ones.

alter table public.users
  add column if not exists granted_roles public.user_role[] not null
  default '{customer}'::public.user_role[];

-- Backfill {role, customer}, deduplicated: customers already hold {customer}
-- from the column default; customer sorts first in the enum.
update public.users
set granted_roles = array['customer'::public.user_role, role]
where role <> 'customer'
  and not (granted_roles @> array[role]);

-- Keep the invariant for every writer (auth routes, seed scripts, the
-- dashboard's user inserts): granted_roles ⊇ {role, customer}, deduplicated,
-- in enum order.
create or replace function public.normalize_users_granted_roles()
returns trigger
language plpgsql
as $$
begin
  new.granted_roles := (
    select array_agg(r order by r)
    from (
      select distinct unnest(
        coalesce(new.granted_roles, '{}'::public.user_role[])
        || array[new.role, 'customer'::public.user_role]
      ) as r
    ) s
  );
  return new;
end;
$$;

create or replace trigger trg_users_normalize_granted_roles
  before insert or update of role, granted_roles on public.users
  for each row execute function public.normalize_users_granted_roles();

-- granted_roles is service-role only, like role. authenticated already can't
-- write it: its column-level UPDATE grant (20261006215408) lists display
-- fields only. The guard trigger adds defence in depth.
-- CREATE OR REPLACE of the guard from 20261009230404_ride_details.sql: its body
-- is kept exactly; only the granted_roles line is added.
create or replace function public.guard_users_privileged_columns()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('anon', 'authenticated') and (
       new.id is distinct from old.id
    or new.role is distinct from old.role
    or new.granted_roles is distinct from old.granted_roles
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
