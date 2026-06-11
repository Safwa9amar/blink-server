-- Agent personal profile (parallel to rider_profiles). The agent's SHOP lives in
-- agent_shops; this holds identity-adjacent fields (wilaya, payout RIB) plus a
-- human-readable display ID. Display IDs are role-prefixed: agent = "BK-AG-"
-- (rider = "BK-RR-"), each with its own sequence. Mirrors agent-profiles.ts.
CREATE SEQUENCE IF NOT EXISTS public.agent_id_seq START WITH 100000;

-- Holds only the display ID — common fields (wilaya, bank_rib) live on users.
CREATE TABLE IF NOT EXISTS agent_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id        TEXT UNIQUE NOT NULL DEFAULT 'BK-AG-' || nextval('agent_id_seq'), -- display ID like "BK-AG-100023"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_user ON agent_profiles(user_id);

CREATE TRIGGER trg_agent_profiles_updated_at
  BEFORE UPDATE ON agent_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE agent_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_profiles_select_own ON agent_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY agent_profiles_update_own ON agent_profiles FOR UPDATE USING (auth.uid() = user_id);
