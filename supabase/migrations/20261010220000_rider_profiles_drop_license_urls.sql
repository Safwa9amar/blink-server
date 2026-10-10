-- Licence scans live in rider_profiles.documents since
-- 20261010210000_rider_verification.sql (values were copied there). A grep
-- across blink, blink-server and blink-dashboard found no reader left.
ALTER TABLE "rider_profiles"
  DROP COLUMN IF EXISTS "license_front_url",
  DROP COLUMN IF EXISTS "license_back_url";
