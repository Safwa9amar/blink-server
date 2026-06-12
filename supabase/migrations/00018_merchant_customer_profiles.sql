-- Merchant + customer personal profiles (parallel to rider_profiles /
-- agent_profiles). Until now only rider and agent had a role table, so merchant
-- and customer accounts had no role-specific row created at signup. These two
-- tables close that gap. Each holds only a human-readable display ID; common
-- fields (name, wilaya, bank_rib, address) live on users. Display IDs are
-- role-prefixed with their own sequence: merchant = "BK-MR-", customer =
-- "BK-CU-" (rider = "BK-RR-", agent = "BK-AG-"). Mirrors
-- src/db/schema/merchant-profiles.ts + customer-profiles.ts.

-- ─── Merchant ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.merchant_id_seq START WITH 100000;

CREATE TABLE IF NOT EXISTS merchant_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id     TEXT UNIQUE NOT NULL DEFAULT 'BK-MR-' || nextval('merchant_id_seq'), -- display ID like "BK-MR-100023"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_merchant_profiles_user ON merchant_profiles(user_id);

CREATE TRIGGER trg_merchant_profiles_updated_at
  BEFORE UPDATE ON merchant_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE merchant_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY merchant_profiles_select_own ON merchant_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY merchant_profiles_update_own ON merchant_profiles FOR UPDATE USING (auth.uid() = user_id);

-- ─── Customer ────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS public.customer_id_seq START WITH 100000;

CREATE TABLE IF NOT EXISTS customer_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer_id     TEXT UNIQUE NOT NULL DEFAULT 'BK-CU-' || nextval('customer_id_seq'), -- display ID like "BK-CU-100023"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_user ON customer_profiles(user_id);

CREATE TRIGGER trg_customer_profiles_updated_at
  BEFORE UPDATE ON customer_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY customer_profiles_select_own ON customer_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY customer_profiles_update_own ON customer_profiles FOR UPDATE USING (auth.uid() = user_id);
