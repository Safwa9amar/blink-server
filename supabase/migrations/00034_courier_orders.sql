-- =====================================================================
-- Blink Server — Courier (parcel) requests as orders
-- =====================================================================
-- Mirrors src/db/schema/enums.ts (order_type += 'courier') and the new
-- nullable orders columns in src/db/schema/orders.ts. Additive only.
-- The customer courier flow posts to POST /orders with type = 'courier';
-- coordinates also let marketplace orders render a tracking map.

ALTER TYPE "public"."order_type" ADD VALUE IF NOT EXISTS 'courier';

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "vehicle_type"    text;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "scheduled_at"    timestamptz;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_lat"      double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "pickup_lng"      double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "destination_lat" double precision;
ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "destination_lng" double precision;
