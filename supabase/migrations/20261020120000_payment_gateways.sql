-- =====================================================================
-- Blink Server — online payment gateways (Chargily, Stripe, SATIM)
-- =====================================================================
-- Authored in Drizzle (src/db/schema/payments.ts); spec:
-- docs/superpowers/specs/2026-10-20-payment-gateways-design.md
--
--   deposit_method 'online'      a rider top-up paid by card
--   payments                     one gateway checkout (wallet top-up or dues)
--   payment_events               webhook idempotency + audit (service role only)
--   blink_cash_gateway_complete  credits an online deposit once the gateway confirmed it

-- Must stay first and must not be used below: a new enum value is not usable in
-- the transaction that adds it.
alter type public.deposit_method add value if not exists 'online';

do $$ begin
  create type public.payment_provider as enum ('chargily', 'stripe', 'satim');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_status as enum ('pending', 'paid', 'failed', 'canceled', 'expired');
exception when duplicate_object then null; end $$;
do $$ begin
  create type public.payment_purpose as enum ('wallet_topup', 'agent_dues', 'merchant_dues');
exception when duplicate_object then null; end $$;

create table if not exists public.payments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.users(id),
  purpose         public.payment_purpose not null,
  -- transactions.id / agent_dues_payments.id / merchant_dues_payments.id (by purpose)
  ref_id          uuid not null,
  provider        public.payment_provider not null,
  method          text not null,
  -- What the card is charged (identical to what the provider is asked for).
  amount          numeric(10, 2) not null check (amount > 0),
  currency        text not null default 'DZD',
  status          public.payment_status not null default 'pending',
  provider_ref    text,
  checkout_url    text,
  livemode        boolean not null default false,
  failure_reason  text,
  paid_at         timestamptz,
  expires_at      timestamptz,
  last_synced_at  timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists payments_provider_ref_key on public.payments (provider, provider_ref);
create index if not exists idx_payments_purpose_ref on public.payments (purpose, ref_id);
create index if not exists idx_payments_status_expires on public.payments (status, expires_at);
create index if not exists idx_payments_user on public.payments (user_id, created_at desc);

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at
  before update on public.payments for each row execute function update_updated_at();

alter table public.payments enable row level security;
drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select using (auth.uid() = user_id);

create table if not exists public.payment_events (
  id           uuid primary key default gen_random_uuid(),
  provider     public.payment_provider not null,
  event_id     text not null,
  type         text not null,
  payment_id   uuid references public.payments(id) on delete set null,
  payload      jsonb not null default '{}'::jsonb,
  received_at  timestamptz not null default now()
);
create unique index if not exists payment_events_provider_event_key on public.payment_events (provider, event_id);
create index if not exists idx_payment_events_payment on public.payment_events (payment_id);
-- No policies: service role only.
alter table public.payment_events enable row level security;

-- Credits an online deposit the gateway confirmed. Idempotent; a payment that
-- lands after the request lapsed (cancelled) is still credited.
create or replace function public.blink_cash_gateway_complete(p_txn uuid, p_reference text)
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
  if t.status = 'completed' then
    return t;
  end if;
  if t.type <> 'deposit' or t.method::text <> 'online' or t.status::text not in ('pending', 'cancelled') then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;

  update public.transactions
    set status = 'completed', completed_at = now(), reference = coalesce(p_reference, reference),
        cancel_reason = null, cancelled_by = null, cancelled_at = null
    where id = p_txn;
  perform public.blink_cash_settle(p_txn);

  select * into t from public.transactions where id = p_txn;
  return t;
end;
$$;

revoke all on function public.blink_cash_gateway_complete(uuid, text) from public, anon, authenticated;
grant execute on function public.blink_cash_gateway_complete(uuid, text) to service_role;

-- Agent confirm (20261016120000_blink_cash_full.sql) + one rule: an online
-- deposit is paid by card, never confirmed by an agent. The route refuses it
-- too (transactions/process.ts); this makes it hold for any caller.
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
  if t.status <> 'pending' or t.method::text = 'online' then
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
