-- Consolidate common/repeated profile fields onto users (alongside address):
-- home province (wilaya) and payout account (bank_rib) are shared across roles,
-- so they live on users rather than being duplicated per role table.
--
-- Moves them OFF rider_profiles (where they were since the baseline). No data
-- backfill needed in dev; if porting to an environment with rider data, copy
-- rider_profiles.wilaya/bank_rib → users before dropping.
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS wilaya text,
  ADD COLUMN IF NOT EXISTS wilaya_code text,
  ADD COLUMN IF NOT EXISTS bank_rib text;

ALTER TABLE public.rider_profiles
  DROP COLUMN IF EXISTS wilaya,
  DROP COLUMN IF EXISTS wilaya_code,
  DROP COLUMN IF EXISTS bank_rib;
