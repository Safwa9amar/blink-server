-- Multi-role accounts: the role an account signed up as, and deleting one role.
--
-- 1. users.signup_role — the role chosen at sign-up. Only an account that
--    signed up as a customer is multi-role in the app (it unlocks partner
--    roles from Become a Partner and switches between them); one that signed
--    up as rider / merchant / agent is that partner only, even though
--    granted_roles always lists customer too (the normalize trigger).
-- 2. account_deletion_requests.scope — `account` (the whole account, as
--    before) or `role` (only `role`: staff take it off granted_roles and clear
--    its documents; the account and its other roles stay). A pending request
--    is now one per user AND role.

-- ─── 1. signup_role ───────────────────────────────────────────────────
alter table public.users
  add column if not exists signup_role public.user_role not null default 'customer';

-- Backfill (every account predates multi-role, 2026-10-10). Sign-up creates
-- the chosen partner role's profile row within a second of the account; a
-- role unlocked later gets it hours or days after. The active role proves
-- nothing (a customer who unlocked rider may be in it now).
--   1. A held partner role whose profile came with the account → that role.
--   2. Else, a partner profile came with the account (it began as a partner
--      and the old self-serve role switch moved it) and it holds exactly one
--      partner role now → that role.
--   3. Else → customer (the column default).
with signup as (
  select u.id,
         array_remove(u.granted_roles, 'customer'::public.user_role) as partners,
         exists (select 1 from public.rider_profiles x
                 where x.user_id = u.id and x.created_at < u.created_at + interval '1 minute') as rider_at_signup,
         exists (select 1 from public.merchant_profiles x
                 where x.user_id = u.id and x.created_at < u.created_at + interval '1 minute') as merchant_at_signup,
         exists (select 1 from public.agent_profiles x
                 where x.user_id = u.id and x.created_at < u.created_at + interval '1 minute') as agent_at_signup
  from public.users u
)
update public.users u
set signup_role = coalesce(
  case
    when 'rider' = any(s.partners) and s.rider_at_signup then 'rider'::public.user_role
    when 'merchant' = any(s.partners) and s.merchant_at_signup then 'merchant'::public.user_role
    when 'agent' = any(s.partners) and s.agent_at_signup then 'agent'::public.user_role
  end,
  case
    when cardinality(s.partners) = 1 and (s.rider_at_signup or s.merchant_at_signup or s.agent_at_signup)
    then s.partners[1]
  end,
  'customer'::public.user_role
)
from signup s
where u.id = s.id;

-- signup_role is service-role only: authenticated's column-level UPDATE grant
-- (20261006215408) lists display fields only, so clients can't write it.

-- ─── 2. Deleting one role ─────────────────────────────────────────────
alter table public.account_deletion_requests
  add column if not exists scope text not null default 'account';

alter table public.account_deletion_requests
  drop constraint if exists account_deletion_requests_scope_check;
alter table public.account_deletion_requests
  add constraint account_deletion_requests_scope_check
  check (scope in ('account', 'role'));

-- Existing requests were all for the whole account (the column default).
-- One pending request per user and role: a customer can have its rider and
-- merchant roles pending removal at once.
drop index if exists public.account_deletion_requests_one_pending;
create unique index account_deletion_requests_one_pending
  on public.account_deletion_requests (user_id, role)
  where status = 'pending';
