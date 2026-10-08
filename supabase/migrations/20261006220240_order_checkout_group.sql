-- =====================================================================
-- Blink Server — Group the per-store orders of one checkout
-- =====================================================================
-- Mirrors src/db/schema/orders.ts (orders.checkout_id). Additive only.
--
-- A customer cart can hold items from several stores. Checkout now creates
-- ONE order per store (each with its own store_id, so every merchant sees
-- theirs) and stamps them all with the same client-generated checkout_id.
-- The customer tracking screen lists the sibling orders through
-- GET /orders?checkout_id=<uuid> (always scoped to the caller), hence the
-- (customer_id, checkout_id) index. NULL for single orders created before
-- this migration and for courier requests.

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "checkout_id" uuid;

CREATE INDEX IF NOT EXISTS "idx_orders_customer_checkout"
  ON "orders" USING btree ("customer_id", "checkout_id");
