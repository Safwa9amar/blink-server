-- Road actually driven while carrying an order.
--
-- orders.route_path / trips.route_path: jsonb array of [lat, lng] pairs,
-- oldest first, appended from the rider's location pings (PATCH /riders/location
-- `path`) while the order is `on_the_way`. Null until picked up. Lets the app
-- show the real road on finished trips instead of the planned one.
--
-- Appending happens in one statement (append_rider_route_path) so concurrent
-- pings never read-modify-write a stale array. The broadcast triggers ignore
-- route_path-only updates, otherwise every ~20 s ping would make customers,
-- riders and merchants refetch.

alter table public.orders add column if not exists route_path jsonb;
alter table public.trips add column if not exists route_path jsonb;

create or replace function public.append_rider_route_path(p_rider uuid, p_points jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
begin
  if p_points is null or jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) = 0 then
    return 0;
  end if;

  -- Cap at 5000 points per order.
  with upd as (
    update public.orders o
    set route_path = coalesce(o.route_path, '[]'::jsonb) || p_points
    where o.rider_id = p_rider
      and o.status = 'on_the_way'
      and jsonb_array_length(coalesce(o.route_path, '[]'::jsonb)) < 5000
    returning o.id
  )
  select coalesce(array_agg(id), '{}') into ids from upd;

  if coalesce(array_length(ids, 1), 0) = 0 then
    return 0;
  end if;

  update public.trips t
  set route_path = coalesce(t.route_path, '[]'::jsonb) || p_points
  where t.order_id = any(ids)
    and jsonb_array_length(coalesce(t.route_path, '[]'::jsonb)) < 5000;

  return array_length(ids, 1);
end;
$$;

-- security definer: only the backend (service role) may call it, never app
-- users through PostgREST.
revoke all on function public.append_rider_route_path(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.append_rider_route_path(uuid, jsonb) to service_role;

-- Broadcast triggers: route_path-only updates are no-ops.
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

  -- Skip no-op updates (only updated_at / route_path changed).
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'updated_at' - 'route_path') = (to_jsonb(old) - 'updated_at' - 'route_path') then
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
     and (to_jsonb(new) - 'updated_at' - 'route_path') = (to_jsonb(old) - 'updated_at' - 'route_path') then
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
