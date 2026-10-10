-- Rides (passenger moto-taxi) — the new enum values only. Additive.
-- Spec: blink/docs/superpowers/specs/2026-10-09-ride-requests-design.md
--
--   order_type        += 'ride'   one order per ride (pickup → destination, one rider)
--   notification_type += 'ride'   ride updates; they open /(customer)/activities/ride/<id>
--
-- Kept apart from 20261009230404_ride_details.sql: a value added to an enum
-- can't be used in the transaction that adds it, and that migration's partial
-- index filters on type = 'ride'.

alter type public.order_type add value if not exists 'ride';
alter type public.notification_type add value if not exists 'ride';
