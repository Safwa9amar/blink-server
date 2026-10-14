-- Promotion controls, coupon provenance and view/tap tracking.
--
-- promotions: spend caps (max_coupons, discount_budget), soft-archive
-- (archived_at) and the staff member who created it.
-- customer_coupons: revoked_at (checkout refuses it), source
-- (promotion | referral | staff), issued_by and a staff note.
-- promotion_events: app views/taps (written by the server, read by the
-- dashboard; no client policies).
-- promotion_usage / promotion_stats / promotion_daily: service-role only
-- aggregates. "Counted orders" = orders using one of the promotion's coupons
-- that are not canceled / merchant_rejected.

alter table public.promotions add column if not exists max_coupons integer;
alter table public.promotions add column if not exists discount_budget numeric(10, 2);
alter table public.promotions add column if not exists archived_at timestamptz;
alter table public.promotions add column if not exists created_by uuid references public.users(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'promotions_max_coupons_positive') then
    alter table public.promotions
      add constraint promotions_max_coupons_positive check (max_coupons is null or max_coupons > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'promotions_discount_budget_positive') then
    alter table public.promotions
      add constraint promotions_discount_budget_positive check (discount_budget is null or discount_budget > 0);
  end if;
end $$;

alter table public.customer_coupons add column if not exists revoked_at timestamptz;
alter table public.customer_coupons add column if not exists source text not null default 'promotion';
alter table public.customer_coupons add column if not exists issued_by uuid references public.users(id) on delete set null;
alter table public.customer_coupons add column if not exists note text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'customer_coupons_source_check') then
    alter table public.customer_coupons
      add constraint customer_coupons_source_check check (source in ('promotion', 'referral', 'staff'));
  end if;
end $$;

-- Backfill referral coupons (the referrals migration may not be applied yet).
do $$
begin
  if to_regclass('public.referrals') is not null then
    update public.customer_coupons c
       set source = 'referral'
      from public.referrals r
     where r.coupon_id = c.id
       and c.source = 'promotion';
  end if;
end $$;

create table if not exists public.promotion_events (
  id uuid primary key default gen_random_uuid(),
  promotion_id uuid not null references public.promotions(id) on delete cascade,
  user_id uuid references public.users(id) on delete set null,
  event text not null check (event in ('view', 'tap')),
  created_at timestamptz not null default now()
);

create index if not exists idx_promotion_events_promo_event_created
  on public.promotion_events (promotion_id, event, created_at);

-- RLS on, no client policies: only the service role reads and writes.
alter table public.promotion_events enable row level security;

-- All-time usage of one promotion, for the server's issue check.
create or replace function public.promotion_usage(p_id uuid)
returns table (issued int, discount_given numeric)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (select count(*)::int from customer_coupons cc where cc.promotion_id = p_id),
    coalesce((
      select sum(o.discount)
        from orders o
        join customer_coupons cc on cc.id = o.coupon_id
       where cc.promotion_id = p_id
         and o.status not in ('canceled', 'merchant_rejected')
    ), 0)::numeric;
$$;

-- One row per promotion. Events/coupons/orders are filtered by their own
-- created_at; null bounds = all time.
create or replace function public.promotion_stats(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  promotion_id uuid,
  views int,
  reach int,
  taps int,
  tappers int,
  issued int,
  used int,
  discount_given numeric,
  orders int,
  revenue numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with ev as (
    select e.promotion_id,
           count(*) filter (where e.event = 'view')::int as views,
           count(distinct e.user_id) filter (where e.event = 'view')::int as reach,
           count(*) filter (where e.event = 'tap')::int as taps,
           count(distinct e.user_id) filter (where e.event = 'tap')::int as tappers
      from promotion_events e
     where (p_from is null or e.created_at >= p_from)
       and (p_to is null or e.created_at < p_to)
     group by e.promotion_id
  ), cp as (
    select cc.promotion_id,
           count(*) filter (
             where (p_from is null or cc.created_at >= p_from)
               and (p_to is null or cc.created_at < p_to)
           )::int as issued,
           count(*) filter (
             where cc.used_at is not null
               and (p_from is null or cc.used_at >= p_from)
               and (p_to is null or cc.used_at < p_to)
           )::int as used
      from customer_coupons cc
     where cc.promotion_id is not null
     group by cc.promotion_id
  ), od as (
    select cc.promotion_id,
           count(*)::int as orders,
           coalesce(sum(o.discount), 0) as discount_given,
           coalesce(sum(o.total), 0) as revenue
      from orders o
      join customer_coupons cc on cc.id = o.coupon_id
     where cc.promotion_id is not null
       and o.status not in ('canceled', 'merchant_rejected')
       and (p_from is null or o.created_at >= p_from)
       and (p_to is null or o.created_at < p_to)
     group by cc.promotion_id
  )
  select p.id,
         coalesce(ev.views, 0),
         coalesce(ev.reach, 0),
         coalesce(ev.taps, 0),
         coalesce(ev.tappers, 0),
         coalesce(cp.issued, 0),
         coalesce(cp.used, 0),
         coalesce(od.discount_given, 0)::numeric,
         coalesce(od.orders, 0),
         coalesce(od.revenue, 0)::numeric
    from promotions p
    left join ev on ev.promotion_id = p.id
    left join cp on cp.promotion_id = p.id
    left join od on od.promotion_id = p.id;
$$;

-- Per Africa/Algiers day for the last p_days days (today included); days
-- without activity still appear. p_promotion null = all promotions.
create or replace function public.promotion_daily(
  p_promotion uuid default null,
  p_days int default 30
)
returns table (
  day date,
  views int,
  taps int,
  issued int,
  used int,
  discount_given numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with days as (
    select d::date as day
      from generate_series(
             (now() at time zone 'Africa/Algiers')::date - (greatest(p_days, 1) - 1),
             (now() at time zone 'Africa/Algiers')::date,
             interval '1 day'
           ) d
  ), ev as (
    select (e.created_at at time zone 'Africa/Algiers')::date as day,
           count(*) filter (where e.event = 'view')::int as views,
           count(*) filter (where e.event = 'tap')::int as taps
      from promotion_events e
     where (p_promotion is null or e.promotion_id = p_promotion)
     group by 1
  ), cp as (
    select (cc.created_at at time zone 'Africa/Algiers')::date as day,
           count(*)::int as issued
      from customer_coupons cc
     where cc.promotion_id is not null
       and (p_promotion is null or cc.promotion_id = p_promotion)
     group by 1
  ), us as (
    select (cc.used_at at time zone 'Africa/Algiers')::date as day,
           count(*)::int as used
      from customer_coupons cc
     where cc.used_at is not null
       and cc.promotion_id is not null
       and (p_promotion is null or cc.promotion_id = p_promotion)
     group by 1
  ), od as (
    select (o.created_at at time zone 'Africa/Algiers')::date as day,
           coalesce(sum(o.discount), 0) as discount_given
      from orders o
      join customer_coupons cc on cc.id = o.coupon_id
     where cc.promotion_id is not null
       and (p_promotion is null or cc.promotion_id = p_promotion)
       and o.status not in ('canceled', 'merchant_rejected')
     group by 1
  )
  select days.day,
         coalesce(ev.views, 0),
         coalesce(ev.taps, 0),
         coalesce(cp.issued, 0),
         coalesce(us.used, 0),
         coalesce(od.discount_given, 0)::numeric
    from days
    left join ev on ev.day = days.day
    left join cp on cp.day = days.day
    left join us on us.day = days.day
    left join od on od.day = days.day
   order by days.day;
$$;

-- Issue a coupon atomically: the promotion row is locked, so concurrent
-- activations can't overshoot max_coupons / discount_budget. Returns the
-- user's coupon for the promotion (existing or new).
create or replace function public.issue_promotion_coupon(
  p_user uuid,
  p_promotion uuid,
  p_code text,
  p_type text,
  p_expires_at timestamptz
)
returns setof public.customer_coupons
language plpgsql
security invoker
set search_path = public
as $$
declare
  p public.promotions%rowtype;
  v_issued int;
  v_given numeric;
begin
  select * into p from promotions where id = p_promotion for update;
  if not found then
    raise exception using message = 'not_live', errcode = 'P0001';
  end if;

  if p.archived_at is not null or not p.is_active
     or (p.starts_at is not null and p.starts_at > now())
     or (p.ends_at is not null and p.ends_at < now()) then
    raise exception using message = 'not_live', errcode = 'P0001';
  end if;

  if p.max_coupons is not null then
    select count(*) into v_issued from customer_coupons cc where cc.promotion_id = p.id;
    if v_issued >= p.max_coupons then
      raise exception using message = 'sold_out', errcode = 'P0001';
    end if;
  end if;

  if p.discount_budget is not null then
    select coalesce(sum(o.discount), 0) into v_given
      from orders o
      join customer_coupons cc on cc.id = o.coupon_id
     where cc.promotion_id = p.id
       and o.status not in ('canceled', 'merchant_rejected');
    if v_given >= p.discount_budget then
      raise exception using message = 'budget_spent', errcode = 'P0001';
    end if;
  end if;

  insert into customer_coupons (
    user_id, promotion_id, code, type, title, description, discount_type,
    discount_value, min_order, max_discount, image_url, expires_at, source
  ) values (
    p_user, p.id, p_code, p_type, p.title, coalesce(p.subtitle, ''), p.discount_type,
    p.discount_value, p.min_order, p.max_discount, nullif(p.image_url, ''), p_expires_at, 'promotion'
  )
  on conflict on constraint customer_coupons_user_promotion_key do nothing;

  return query
    select * from customer_coupons cc
     where cc.user_id = p_user and cc.promotion_id = p.id;
end;
$$;

revoke execute on function public.promotion_usage(uuid) from public, anon, authenticated;
revoke execute on function public.promotion_stats(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.promotion_daily(uuid, int) from public, anon, authenticated;
grant execute on function public.promotion_usage(uuid) to service_role;
grant execute on function public.promotion_stats(timestamptz, timestamptz) to service_role;
grant execute on function public.promotion_daily(uuid, int) to service_role;
revoke execute on function public.issue_promotion_coupon(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.issue_promotion_coupon(uuid, uuid, text, text, timestamptz) to service_role;
