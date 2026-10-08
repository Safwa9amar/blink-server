-- Rider offer handshake.
-- (Applied via the Supabase MCP, which recorded version 20261007180407 — the
-- filename matches that so `supabase db push` sees local == remote.)
--
-- A store's "assign a rider" no longer writes the rider onto the order. It
-- records a pending REQUEST to one rider (offered_*); the order stays
-- `searching` (customer: "searching for a rider", merchant: "waiting for
-- <rider>"). Only the rider's accept (POST /riders/jobs/{id}/accept) sets
-- rider_id / rider_assigned_at / status heading_to_store, so customer, merchant
-- and rider move forward together. Rules: src/lib/rider-offer.ts.
--
--   offered_rider_id   the rider asked to deliver (pending until accepted)
--   offered_driver_id  the store_drivers row when the request goes to the
--                      store's own app driver (offered_mode = 'own')
--   offered_mode       'own' (store's driver, no Blink trip) | 'blink'
--   offered_at         when the request was sent (server clock; TTL in code)
--   offer_declined_at  set when the rider declines / becomes unavailable; the
--                      offered_* columns are kept so the merchant can see who
--
-- The broadcast trigger also notifies the requested rider (new + old). The new
-- column is read through to_jsonb() so a later rename/drop of the column can
-- never make order writes fail. Everything else in the function is unchanged
-- from 20261006212629_order_realtime.sql.

alter table public.orders
  add column if not exists offered_rider_id  uuid references public.users(id) on delete set null,
  add column if not exists offered_driver_id uuid references public.store_drivers(id) on delete set null,
  add column if not exists offered_mode      text check (offered_mode in ('own', 'blink')),
  add column if not exists offered_at        timestamptz,
  add column if not exists offer_declined_at timestamptz;

create index if not exists idx_orders_offered_rider
  on public.orders (offered_rider_id)
  where offered_rider_id is not null;

create or replace function public.broadcast_order_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.orders;
  recipients uuid[] := '{}';
  payload jsonb;
  uid uuid;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  -- Skip no-op updates (e.g. only updated_at bumped).
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;

  recipients := array[r.customer_id, r.rider_id, (to_jsonb(r) ->> 'offered_rider_id')::uuid];
  if tg_op = 'UPDATE' then
    recipients := recipients || old.rider_id || (to_jsonb(old) ->> 'offered_rider_id')::uuid;
  end if;

  if r.store_id is not null then
    recipients := recipients || (select s.owner_id from public.stores s where s.id = r.store_id);
  end if;

  recipients := recipients || array(
    select d.rider_user_id from public.store_drivers d
    where d.id in (r.store_driver_id, case when tg_op = 'UPDATE' then old.store_driver_id end)
      and d.rider_user_id is not null
  );

  payload := jsonb_build_object(
    'table', 'orders',
    'op', lower(tg_op),
    'id', r.id,
    'status', r.status,
    'merchant_status', r.merchant_status
  );

  for uid in select distinct x from unnest(recipients) as x where x is not null loop
    perform realtime.send(payload, 'order_changed', 'user:' || uid::text, true);
  end loop;

  -- Unassigned searching orders feed rider offers; announce pool changes.
  if (r.status = 'searching' and r.rider_id is null)
     or (tg_op = 'UPDATE' and old.status = 'searching' and old.rider_id is null) then
    perform realtime.send(
      jsonb_build_object('table', 'orders', 'id', r.id),
      'offers_changed', 'riders:offers', true
    );
  end if;

  return null;
end;
$$;
