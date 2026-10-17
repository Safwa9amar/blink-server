-- Customer referrals: tracking referral codes, invited friends, statuses, and rewards
CREATE TABLE IF NOT EXISTS public.referrals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  referral_code   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  reward_amount   NUMERIC(10, 2) NOT NULL DEFAULT 500.00,
  discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 500.00,
  service_type    TEXT NOT NULL DEFAULT 'delivery',
  order_id        UUID REFERENCES orders(id) ON DELETE SET NULL,
  coupon_id       UUID REFERENCES customer_coupons(id) ON DELETE SET NULL,
  friend_name     TEXT,
  friend_phone    TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT referrals_referred_unique UNIQUE (referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code ON referrals(referral_code);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_referrals_updated_at'
  ) THEN
    CREATE TRIGGER trg_referrals_updated_at
      BEFORE UPDATE ON referrals FOR EACH ROW EXECUTE FUNCTION update_updated_at();
  END IF;
END $$;

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'referrals_select_own' AND tablename = 'referrals'
  ) THEN
    CREATE POLICY referrals_select_own ON referrals
      FOR SELECT USING (auth.uid() = referrer_id OR auth.uid() = referred_id);
  END IF;
END $$;
