-- (Applied via the Supabase MCP, which recorded version 20261006215408 — the
-- filename matches that so `supabase db push` sees local == remote.)
--
-- Clients (anon / authenticated JWTs via PostgREST) could UPDATE any column of
-- their own users row — including role and staff_role (self-promotion to
-- rider / super_admin), pin_hash, bank_rib, phone_number and email. Lock it
-- down to display fields; everything else is written by the server or the
-- dashboard with the service role. The mobile app's only direct write is
-- users.profile_picture (store/auth-store.ts avatar upload).

revoke insert, update, delete, truncate on public.users from anon, authenticated;

grant update (
  first_name, middle_name, last_name, profile_picture,
  gender, birthday, address, wilaya, wilaya_code
) on public.users to authenticated;

alter policy users_update_own on public.users
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Defence in depth: even if a broad GRANT is re-added later, client roles can
-- never change identity / privilege / financial columns.
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
  return new;
end;
$$;

create or replace trigger trg_users_guard_privileged
  before update on public.users
  for each row execute function public.guard_users_privileged_columns();
