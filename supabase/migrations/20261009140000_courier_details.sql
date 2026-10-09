-- Courier requests (parcel delivery) — details the rider needs, and the
-- customer's cancel reason / rider rating. Additive only.
-- Spec: blink/docs/superpowers/specs/2026-10-09-courier-requests-design.md
--
--   courier           courier orders only (type = 'courier'):
--                     { pickup {label,address,lat,lng,contact_name,contact_phone,note},
--                       drop_offs [{label,address,lat,lng,recipient_name,recipient_phone,
--                                   note,delivered_at}],
--                       parcel {type,size,note}, paid_by 'sender'|'recipient', distance_km }
--                     Shape validated by the API (src/validators/courier.ts). The flat
--                     pickup_* / destination_* columns keep the pickup and the LAST drop-off.
--   courier_group_id  the orders (one per route, each its own rider) of one courier request
--   cancel_reason     why the order was canceled (customer reason key, or 'no_rider')
--   cancel_note       the customer's free-text details
--   rider_rating      the customer's 1-5 rating of the rider, after delivery
--   rider_review      … with an optional comment
--   rider_tags        … and the compliment tags picked on the rating screen

alter table public.orders
  add column if not exists courier          jsonb,
  add column if not exists courier_group_id uuid,
  add column if not exists cancel_reason    text,
  add column if not exists cancel_note      text,
  add column if not exists rider_rating     smallint check (rider_rating between 1 and 5),
  add column if not exists rider_review     text,
  add column if not exists rider_tags       text[];

create index if not exists idx_orders_courier_group
  on public.orders (courier_group_id)
  where courier_group_id is not null;

-- The courier-timeouts cron scans unclaimed courier requests.
create index if not exists idx_orders_courier_searching
  on public.orders (created_at)
  where type = 'courier' and status = 'searching' and rider_id is null;
