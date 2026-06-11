-- Auto-generate the rider display ID ("BK-####") in the database instead of in
-- app code (which hand-rolled it with Math.random()). A dedicated sequence backs
-- a column DEFAULT, so inserts that omit rider_id get a collision-free value.
--
-- Mirrors the Drizzle schema (src/db/schema/rider-profiles.ts: `riderIdSeq` +
-- the rider_id default). Start high (100000) so generated IDs (BK-100000, …)
-- never collide with the 4-digit random IDs (BK-1000..BK-9999) created before
-- this migration.
CREATE SEQUENCE IF NOT EXISTS public.rider_id_seq START WITH 100000;

-- Display IDs are role-prefixed: rider = "BK-RR-" (agent = "BK-AG-", etc).
ALTER TABLE public.rider_profiles
  ALTER COLUMN rider_id SET DEFAULT 'BK-RR-' || nextval('public.rider_id_seq');
