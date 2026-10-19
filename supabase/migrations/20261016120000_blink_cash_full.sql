-- Full Blink Cash: wallet ledger, transaction lifecycle, settings, offers,
-- agent credit limit, finance audit, PIN lockout.
-- Design: blink-dashboard-cash/docs/superpowers/specs/2026-10-16-blink-cash-full-design.md
--
-- Idempotent. Every table is service-role written (RLS on); riders may only
-- select their own wallet and entries. The money functions are security
-- definer, lock the wallet row (and the transaction row) FOR UPDATE and raise
-- P0001 with one of: insufficient_funds, wallet_frozen, not_pending, expired,
-- wrong_agent, not_found, not_completed, not_in_review.
--
-- The new enum values (review, reversed) are only referenced inside plpgsql
-- function bodies: Postgres refuses to use an enum value added in the same
-- transaction, but a function body is not evaluated until it runs.

-- ─── Enum ────────────────────────────────────────────────────────────

alter type public.transaction_status add value if not exists 'review';
alter type public.transaction_status add value if not exists 'reversed';

-- ─── Settings (single row) ───────────────────────────────────────────

create table if not exists public.blink_cash_settings (
  id boolean primary key default true check (id),
  deposit_fee_rate numeric(6,4) not null default 0.02 check (deposit_fee_rate >= 0 and deposit_fee_rate < 1),
  withdrawal_fee_rate numeric(6,4) not null default 0.02 check (withdrawal_fee_rate >= 0 and withdrawal_fee_rate < 1),
  min_amount numeric(14,2) not null default 1000 check (min_amount > 0),
  max_amount numeric(14,2) not null default 100000 check (max_amount >= min_amount),
  daily_deposit_limit numeric(14,2) not null default 200000,
  daily_withdrawal_limit numeric(14,2) not null default 100000,
  monthly_deposit_limit numeric(14,2) not null default 1000000,
  monthly_withdrawal_limit numeric(14,2) not null default 500000,
  pending_expiry_minutes integer not null default 15 check (pending_expiry_minutes > 0),
  agent_credit_limit numeric(14,2) not null default 200000,
  electronic_enabled boolean not null default false,
  electronic_accounts jsonb not null default '[]'::jsonb,
  require_pin_for_withdrawal boolean not null default false,
  quick_amounts integer[] not null default '{1000,2000,5000,10000}',
  dues_payment_methods jsonb not null default '[{"id":"cash_office","label":"Cash at Blink office"},{"id":"ccp","label":"CCP"},{"id":"baridimob","label":"BaridiMob"}]'::jsonb,
  adjust_limit_finance_admin numeric(14,2) not null default 50000,
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.blink_cash_settings enable row level security;
insert into public.blink_cash_settings (id) values (true) on conflict (id) do nothing;

-- ─── Deposit offers ──────────────────────────────────────────────────
-- bonus_value is an amount in DA for 'fixed', a percentage (10 = 10 %) for 'percent'.

create table if not exists public.blink_cash_offers (
  id uuid primary key default gen_random_uuid(),
  title jsonb not null default '{}'::jsonb,
  description jsonb not null default '{}'::jsonb,
  min_deposit numeric(14,2) not null default 0,
  bonus_type text not null check (bonus_type in ('fixed', 'percent')),
  bonus_value numeric(14,2) not null check (bonus_value > 0),
  max_bonus numeric(14,2),
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  per_user_limit integer default 1,
  budget numeric(14,2),
  used_count integer not null default 0,
  used_amount numeric(14,2) not null default 0,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.blink_cash_offers enable row level security;
create index if not exists idx_blink_cash_offers_active on public.blink_cash_offers (active, ends_at);
drop trigger if exists trg_blink_cash_offers_updated_at on public.blink_cash_offers;
create trigger trg_blink_cash_offers_updated_at
  before update on public.blink_cash_offers for each row execute function update_updated_at();

-- ─── Finance audit ───────────────────────────────────────────────────

create table if not exists public.finance_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  amount numeric(14,2),
  reason text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.finance_audit_events enable row level security;
create index if not exists idx_finance_audit_created on public.finance_audit_events (created_at desc);
create index if not exists idx_finance_audit_actor on public.finance_audit_events (actor_id);
create index if not exists idx_finance_audit_target on public.finance_audit_events (target_type, target_id);

-- ─── transactions: lifecycle columns ─────────────────────────────────

alter table public.transactions
  add column if not exists expires_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancel_reason text,
  add column if not exists cancelled_by uuid references public.users(id) on delete set null,
  add column if not exists reviewed_by uuid references public.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reference text,
  add column if not exists receipt_url text,
  add column if not exists payout_account jsonb,
  add column if not exists client_ref uuid,
  add column if not exists reversed_by uuid references public.users(id) on delete set null,
  add column if not exists reversed_at timestamptz,
  add column if not exists reversal_reason text,
  add column if not exists offer_id uuid references public.blink_cash_offers(id) on delete set null,
  add column if not exists bonus_amount numeric(10,2),
  add column if not exists staff_note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_cancel_reason_check') then
    alter table public.transactions
      add constraint transactions_cancel_reason_check
      check (cancel_reason is null or cancel_reason in ('rider', 'agent', 'expired', 'staff', 'rejected'));
  end if;
end $$;

create unique index if not exists uq_transactions_client_ref
  on public.transactions (user_id, client_ref) where client_ref is not null;
create index if not exists idx_transactions_expires
  on public.transactions (expires_at) where expires_at is not null;
create index if not exists idx_transactions_offer
  on public.transactions (offer_id) where offer_id is not null;

-- Pending rows from before this deploy have no expiry: let them lapse on the first run.
update public.transactions
  set expires_at = created_at + interval '15 minutes'
  where status = 'pending' and expires_at is null;

-- ─── Dues payments: staff confirmation trail ─────────────────────────

alter table public.agent_dues_payments
  add column if not exists reference text,
  add column if not exists note text,
  add column if not exists recorded_by uuid references public.users(id) on delete set null,
  add column if not exists confirmed_by uuid references public.users(id) on delete set null,
  add column if not exists confirmed_at timestamptz,
  add column if not exists rejected_reason text;

alter table public.merchant_dues_payments
  add column if not exists reference text,
  add column if not exists note text,
  add column if not exists recorded_by uuid references public.users(id) on delete set null,
  add column if not exists confirmed_by uuid references public.users(id) on delete set null,
  add column if not exists confirmed_at timestamptz,
  add column if not exists rejected_reason text;

-- NOT VALID: existing rows are not re-checked, new and updated rows are.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'merchant_dues_payments_amount_check') then
    alter table public.merchant_dues_payments
      add constraint merchant_dues_payments_amount_check check (amount > 0) not valid;
  end if;
end $$;

-- ─── Agent cash limit, PIN lockout ───────────────────────────────────

alter table public.agent_profiles
  add column if not exists credit_limit numeric(14,2),
  -- Last "near your cash limit" push (at most one a day).
  add column if not exists limit_warned_at timestamptz;

alter table public.users
  add column if not exists pin_failed_attempts integer not null default 0,
  add column if not exists pin_locked_until timestamptz;

-- ─── Ledger ──────────────────────────────────────────────────────────

create table if not exists public.blink_wallets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id),
  role public.user_role not null,
  balance numeric(14,2) not null default 0,
  held numeric(14,2) not null default 0 check (held >= 0),
  status text not null default 'active' check (status in ('active', 'frozen')),
  frozen_reason text,
  frozen_by uuid references public.users(id) on delete set null,
  frozen_at timestamptz,
  backfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);
alter table public.blink_wallets enable row level security;
drop trigger if exists trg_blink_wallets_updated_at on public.blink_wallets;
create trigger trg_blink_wallets_updated_at
  before update on public.blink_wallets for each row execute function update_updated_at();

create table if not exists public.blink_wallet_entries (
  id uuid primary key default gen_random_uuid(),
  wallet_id uuid not null references public.blink_wallets(id),
  kind text not null check (kind in (
    'opening_balance', 'deposit', 'withdrawal', 'trip', 'challenge_reward',
    'offer_bonus', 'adjustment', 'reversal'
  )),
  amount numeric(14,2) not null check (amount <> 0),
  balance_after numeric(14,2) not null,
  idempotency_key text not null unique,
  transaction_id uuid references public.transactions(id),
  ref_type text,
  ref_id text,
  memo text,
  actor_id uuid,
  created_at timestamptz not null default now()
);
alter table public.blink_wallet_entries enable row level security;
create index if not exists idx_blink_wallet_entries_wallet
  on public.blink_wallet_entries (wallet_id, created_at desc);
create index if not exists idx_blink_wallet_entries_txn
  on public.blink_wallet_entries (transaction_id) where transaction_id is not null;

create or replace function public.blink_wallet_entries_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'blink_wallet_entries is append-only';
end;
$$;

drop trigger if exists trg_blink_wallet_entries_append_only on public.blink_wallet_entries;
create trigger trg_blink_wallet_entries_append_only
  before update or delete on public.blink_wallet_entries
  for each row execute function public.blink_wallet_entries_append_only();
drop trigger if exists trg_blink_wallet_entries_no_truncate on public.blink_wallet_entries;
create trigger trg_blink_wallet_entries_no_truncate
  before truncate on public.blink_wallet_entries
  for each statement execute function public.blink_wallet_entries_append_only();

create table if not exists public.blink_wallet_holds (
  transaction_id uuid primary key references public.transactions(id),
  wallet_id uuid not null references public.blink_wallets(id),
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'active' check (status in ('active', 'released', 'captured')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.blink_wallet_holds enable row level security;
create index if not exists idx_blink_wallet_holds_wallet on public.blink_wallet_holds (wallet_id);

-- ─── RLS: select own ─────────────────────────────────────────────────

drop policy if exists blink_wallets_select_own on public.blink_wallets;
create policy blink_wallets_select_own on public.blink_wallets
  for select using (auth.uid() = user_id);

drop policy if exists blink_wallet_entries_select_own on public.blink_wallet_entries;
create policy blink_wallet_entries_select_own on public.blink_wallet_entries
  for select using (
    exists (select 1 from public.blink_wallets w where w.id = wallet_id and w.user_id = auth.uid())
  );

-- ─── Functions ───────────────────────────────────────────────────────

-- The wallet row, created when missing, locked for the rest of the transaction.
create or replace function public.blink_wallet_lock(p_user uuid, p_role public.user_role)
returns public.blink_wallets
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.blink_wallets;
begin
  insert into public.blink_wallets (user_id, role) values (p_user, p_role)
    on conflict (user_id, role) do nothing;
  select * into w from public.blink_wallets where user_id = p_user and role = p_role for update;
  return w;
end;
$$;

create or replace function public.blink_wallet_post(
  p_user uuid,
  p_role public.user_role,
  p_amount numeric,
  p_kind text,
  p_idem text,
  p_txn uuid default null,
  p_ref_type text default null,
  p_ref_id text default null,
  p_memo text default null,
  p_actor uuid default null,
  p_allow_negative boolean default false
)
returns public.blink_wallet_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.blink_wallets;
  e public.blink_wallet_entries;
begin
  w := public.blink_wallet_lock(p_user, p_role);

  -- Replay: the same key returns the entry already posted.
  select * into e from public.blink_wallet_entries where idempotency_key = p_idem;
  if found then
    return e;
  end if;

  if p_amount is null or p_amount = 0 then
    raise exception 'invalid_amount' using errcode = 'P0001';
  end if;
  if w.status = 'frozen' and p_kind = 'withdrawal' then
    raise exception 'wallet_frozen' using errcode = 'P0001';
  end if;
  if p_amount < 0 and not p_allow_negative and w.balance + p_amount - w.held < 0 then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;

  insert into public.blink_wallet_entries
    (wallet_id, kind, amount, balance_after, idempotency_key, transaction_id, ref_type, ref_id, memo, actor_id)
  values
    (w.id, p_kind, round(p_amount, 2), round(w.balance + p_amount, 2), p_idem, p_txn, p_ref_type, p_ref_id, p_memo, p_actor)
  returning * into e;

  update public.blink_wallets set balance = round(w.balance + p_amount, 2) where id = w.id;
  return e;
end;
$$;

-- A rider withdrawal request: the row and the hold in one statement, so funds
-- can't be promised twice.
create or replace function public.blink_cash_create_withdrawal(
  p_user uuid,
  p_amount numeric,
  p_fees numeric,
  p_method public.deposit_method,
  p_agent uuid,
  p_shop uuid,
  p_status text,
  p_expires_at timestamptz,
  p_client_ref uuid,
  p_payout_account jsonb,
  p_pending_id uuid
)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  w public.blink_wallets;
  t public.transactions;
begin
  w := public.blink_wallet_lock(p_user, 'rider');
  if w.status = 'frozen' then
    raise exception 'wallet_frozen' using errcode = 'P0001';
  end if;
  if p_amount > w.balance - w.held then
    raise exception 'insufficient_funds' using errcode = 'P0001';
  end if;

  insert into public.transactions
    (type, user_id, rider_id, agent_id, shop_id, amount, fees, total, status, method,
     pending_id, expires_at, client_ref, payout_account)
  values
    ('withdrawal', p_user, p_user, p_agent, p_shop, p_amount, p_fees, p_amount - p_fees,
     p_status::public.transaction_status, p_method,
     p_pending_id, p_expires_at, p_client_ref, p_payout_account)
  returning * into t;

  insert into public.blink_wallet_holds (transaction_id, wallet_id, amount) values (t.id, w.id, p_amount);
  update public.blink_wallets set held = held + p_amount where id = w.id;
  return t;
end;
$$;

-- Moves the money of a transaction that was just marked completed: deposit
-- credits (and pays the offer bonus), withdrawal captures its hold.
create or replace function public.blink_cash_settle(p_txn uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
  w public.blink_wallets;
  h public.blink_wallet_holds;
  o public.blink_cash_offers;
  v_bonus numeric := 0;
  v_used integer;
begin
  select * into t from public.transactions where id = p_txn;
  w := public.blink_wallet_lock(t.user_id, 'rider');

  if t.type = 'deposit' then
    perform public.blink_wallet_post(
      t.user_id, 'rider', t.amount, 'deposit', 'txn:' || t.id, t.id, 'transaction', t.id::text);

    if t.offer_id is not null then
      select * into o from public.blink_cash_offers where id = t.offer_id for update;
      if found
         and o.active
         and (o.starts_at is null or o.starts_at <= now())
         and (o.ends_at is null or o.ends_at > now())
         and t.amount >= o.min_deposit then
        v_bonus := case o.bonus_type
          when 'fixed' then o.bonus_value
          else round(t.amount * o.bonus_value / 100, 2)
        end;
        if o.max_bonus is not null then
          v_bonus := least(v_bonus, o.max_bonus);
        end if;
        if o.per_user_limit is not null then
          select count(*) into v_used from public.transactions x
            where x.offer_id = o.id and x.user_id = t.user_id and x.id <> t.id
              and x.status = 'completed' and coalesce(x.bonus_amount, 0) > 0;
          if v_used >= o.per_user_limit then
            v_bonus := 0;
          end if;
        end if;
        if o.budget is not null and o.used_amount + v_bonus > o.budget then
          v_bonus := 0;
        end if;
        if v_bonus > 0 then
          perform public.blink_wallet_post(
            t.user_id, 'rider', v_bonus, 'offer_bonus', 'bonus:' || t.id, t.id, 'offer', o.id::text);
          update public.transactions set bonus_amount = v_bonus where id = t.id;
          update public.blink_cash_offers
            set used_count = used_count + 1, used_amount = used_amount + v_bonus
            where id = o.id;
        end if;
      end if;
    end if;
  else
    select * into h from public.blink_wallet_holds
      where transaction_id = t.id and status = 'active' for update;
    if found then
      update public.blink_wallet_holds set status = 'captured', resolved_at = now()
        where transaction_id = t.id;
      update public.blink_wallets set held = greatest(0, held - h.amount) where id = w.id;
      -- The cash is out the door: the reserved amount always posts.
      perform public.blink_wallet_post(
        t.user_id, 'rider', -t.amount, 'withdrawal', 'txn:' || t.id, t.id, 'transaction', t.id::text,
        null, null, true);
    else
      -- Request from before holds existed: checked against the balance now.
      perform public.blink_wallet_post(
        t.user_id, 'rider', -t.amount, 'withdrawal', 'txn:' || t.id, t.id, 'transaction', t.id::text);
    end if;
  end if;
end;
$$;

-- Agent confirms a pending request.
create or replace function public.blink_cash_complete(p_txn uuid, p_agent uuid, p_shop uuid)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
begin
  select * into t from public.transactions where id = p_txn for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if t.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  if t.expires_at is not null and t.expires_at <= now() then
    raise exception 'expired' using errcode = 'P0001';
  end if;
  if t.agent_id is not null and t.agent_id <> p_agent then
    raise exception 'wrong_agent' using errcode = 'P0001';
  end if;

  update public.transactions
    set status = 'completed', completed_at = now(), agent_id = p_agent, shop_id = p_shop
    where id = p_txn;
  perform public.blink_cash_settle(p_txn);

  select * into t from public.transactions where id = p_txn;
  return t;
end;
$$;

-- Staff approves an electronic request that is in review.
create or replace function public.blink_cash_approve(p_txn uuid, p_actor uuid, p_reference text default null)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
begin
  select * into t from public.transactions where id = p_txn for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if t.status <> 'review' then
    raise exception 'not_in_review' using errcode = 'P0001';
  end if;

  update public.transactions
    set status = 'completed', completed_at = now(), reviewed_by = p_actor, reviewed_at = now(),
        reference = coalesce(p_reference, reference)
    where id = p_txn;
  perform public.blink_cash_settle(p_txn);

  select * into t from public.transactions where id = p_txn;
  return t;
end;
$$;

-- Cancels a pending / in-review request and releases its hold.
-- p_reason: rider | agent | expired | staff | rejected.
create or replace function public.blink_cash_cancel(p_txn uuid, p_reason text, p_actor uuid default null)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
  h public.blink_wallet_holds;
begin
  select * into t from public.transactions where id = p_txn for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if t.status not in ('pending', 'review') then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;

  update public.transactions
    set status = 'cancelled', cancel_reason = p_reason, cancelled_by = p_actor, cancelled_at = now()
    where id = p_txn;

  select * into h from public.blink_wallet_holds where transaction_id = p_txn and status = 'active' for update;
  if found then
    perform 1 from public.blink_wallets where id = h.wallet_id for update;
    update public.blink_wallet_holds set status = 'released', resolved_at = now() where transaction_id = p_txn;
    update public.blink_wallets set held = greatest(0, held - h.amount) where id = h.wallet_id;
  end if;

  select * into t from public.transactions where id = p_txn;
  return t;
end;
$$;

-- Completed -> reversed, with the opposite ledger entry (and the offer bonus taken back).
create or replace function public.blink_cash_reverse(p_txn uuid, p_actor uuid, p_reason text)
returns public.transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  t public.transactions;
begin
  select * into t from public.transactions where id = p_txn for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if t.status <> 'completed' then
    raise exception 'not_completed' using errcode = 'P0001';
  end if;

  update public.transactions
    set status = 'reversed', reversed_by = p_actor, reversed_at = now(), reversal_reason = p_reason
    where id = p_txn;

  perform public.blink_wallet_post(
    t.user_id, 'rider',
    case when t.type = 'deposit' then -t.amount else t.amount end,
    'reversal', 'reverse:' || t.id, t.id, 'transaction', t.id::text, p_reason, p_actor, true);

  if coalesce(t.bonus_amount, 0) > 0 then
    perform public.blink_wallet_post(
      t.user_id, 'rider', -t.bonus_amount, 'reversal', 'reverse-bonus:' || t.id,
      t.id, 'transaction', t.id::text, p_reason, p_actor, true);
    if t.offer_id is not null then
      update public.blink_cash_offers
        set used_count = greatest(0, used_count - 1),
            used_amount = greatest(0, used_amount - t.bonus_amount)
        where id = t.offer_id;
    end if;
  end if;

  select * into t from public.transactions where id = p_txn;
  return t;
end;
$$;

-- Cancels every lapsed pending request (all, or one user's as owner or agent).
-- Scheduled every minute; the server also calls it lazily before reads.
create or replace function public.blink_cash_expire_pending(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select id from public.transactions
      where status = 'pending' and expires_at is not null and expires_at < now()
        and (p_user is null or user_id = p_user or agent_id = p_user)
      order by expires_at
      for update skip locked
  loop
    begin
      perform public.blink_cash_cancel(r.id, 'expired', null);
      n := n + 1;
    exception when others then
      raise warning 'blink_cash_expire_pending % failed: %', r.id, sqlerrm;
    end;
  end loop;
  return n;
end;
$$;

-- Service role only.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'blink_wallet_lock', 'blink_wallet_post', 'blink_cash_create_withdrawal',
        'blink_cash_settle', 'blink_cash_complete', 'blink_cash_approve',
        'blink_cash_cancel', 'blink_cash_reverse', 'blink_cash_expire_pending'
      )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- ─── Expiry job (pg_cron) ────────────────────────────────────────────
-- Best effort: without the extension the server's lazy expiry still covers reads.

do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron unavailable (%), skipping blink-cash-expire schedule', sqlerrm;
    return;
  end;
  begin
    if exists (select 1 from cron.job where jobname = 'blink-cash-expire') then
      perform cron.unschedule('blink-cash-expire');
    end if;
    perform cron.schedule('blink-cash-expire', '* * * * *', 'select public.blink_cash_expire_pending()');
  exception when others then
    raise notice 'could not schedule blink-cash-expire (%)', sqlerrm;
  end;
end $$;
