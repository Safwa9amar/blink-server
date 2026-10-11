-- Merchant catalog review: the staff note behind a product / pack decision,
-- and the moment a pack's free delivery was approved.
--
-- store_products.review_note — why staff rejected a product or a price
--   suggestion (shown to the merchant; cleared when the merchant resubmits).
-- store_packs.review_note    — why staff rejected a pack's free delivery.
-- store_packs.reviewed_at    — set when staff approve a free-delivery pack.
--   A free-delivery pack may only go live while this is set; editing the
--   items, discount or free delivery clears it and sends the pack back to
--   review.

alter table public.store_products add column if not exists review_note text;
alter table public.store_packs add column if not exists review_note text;
alter table public.store_packs add column if not exists reviewed_at timestamptz;

-- Free-delivery packs that are already live count as approved, so the new
-- rule doesn't pull them back into review.
update public.store_packs
   set reviewed_at = coalesce(updated_at, now())
 where status = 'active'
   and free_delivery
   and reviewed_at is null;
