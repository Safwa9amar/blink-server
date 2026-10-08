-- Real-time order / trip sync across roles.
-- (Applied via the Supabase MCP, which recorded version 20261006212629 — the
-- filename matches that so `supabase db push` sees local == remote.)
--
-- Every meaningful change to an order (status, merchant_status, rider
-- assignment, cancel, rating…) or a trip is broadcast from the database via
-- Supabase Realtime Broadcast to a PRIVATE per-user topic `user:<uuid>` for
-- each party involved:
--   orders → customer, rider (old + new), store owner, store driver (old + new)
--   trips  → customer, rider
-- Orders entering/leaving the unassigned `searching` pool are also announced on
-- `riders:offers` so online riders refresh their offer immediately.
--
-- Payloads carry ids + status only (no PII); clients treat an event as "your
-- cached copy is stale" and refetch through the API. Doing this in a trigger
-- (not in route handlers) catches every write path: API, dashboard, cron, SQL.

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

  recipients := array[r.customer_id, r.rider_id];
  if tg_op = 'UPDATE' then
    recipients := recipients || old.rider_id;
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

create or replace trigger trg_orders_broadcast
  after insert or update or delete on public.orders
  for each row execute function public.broadcast_order_change();

create or replace function public.broadcast_trip_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.trips;
  payload jsonb;
  uid uuid;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;

  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return null;
  end if;

  payload := jsonb_build_object('table', 'trips', 'op', lower(tg_op), 'id', r.id, 'status', r.status);

  for uid in
    select distinct x from unnest(array[r.customer_id, r.rider_id,
      case when tg_op = 'UPDATE' then old.rider_id end]) as x
    where x is not null
  loop
    perform realtime.send(payload, 'trip_changed', 'user:' || uid::text, true);
  end loop;

  return null;
end;
$$;

create or replace trigger trg_trips_broadcast
  after insert or update or delete on public.trips
  for each row execute function public.broadcast_trip_change();

-- Private-channel authorization: a user may only receive their own topic;
-- riders may also receive the shared offers topic. Public channels (support
-- chat) are unaffected by policies on realtime.messages.
drop policy if exists "blink_receive_own_topics" on realtime.messages;
create policy "blink_receive_own_topics"
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (
      realtime.topic() = 'user:' || auth.uid()::text
      or (
        realtime.topic() = 'riders:offers'
        and exists (
          select 1 from public.users u where u.id = auth.uid() and u.role = 'rider'
        )
      )
    )
  );
