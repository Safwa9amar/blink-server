-- =====================================================================
-- Blink Server — Initial Database Schema
-- =====================================================================

-- ─── Enums ───────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('customer', 'rider', 'merchant', 'agent');
CREATE TYPE gender AS ENUM ('male', 'female');
CREATE TYPE vehicle_type AS ENUM ('bicycle', 'motorcycle');
CREATE TYPE vehicle_category AS ENUM ('standard', 'electric', 'hybrid');
CREATE TYPE document_status AS ENUM ('approved', 'needs_update', 'pending', 'not_uploaded');
CREATE TYPE trip_status AS ENUM ('upcoming', 'completed', 'under_review', 'canceled');
CREATE TYPE dispute_status AS ENUM ('under_review', 'pending', 'decision_issued');
CREATE TYPE transaction_status AS ENUM ('completed', 'cancelled', 'pending');
CREATE TYPE transaction_type AS ENUM ('deposit', 'withdrawal');
CREATE TYPE deposit_method AS ENUM ('electronic', 'agent');
CREATE TYPE order_status AS ENUM (
  'searching', 'heading_to_store', 'preparation', 'pickup',
  'on_the_way', 'delivered', 'canceled', 'merchant_rejected', 'processing'
);
CREATE TYPE order_type AS ENUM ('merchant', 'shopper');
CREATE TYPE notification_type AS ENUM (
  'courier', 'promo', 'offer', 'order', 'security',
  'news', 'alert', 'announcement', 'benefit', 'deposit'
);
CREATE TYPE address_type AS ENUM ('home', 'work', 'other');
CREATE TYPE agent_shop_status AS ENUM ('open', 'closed');

-- ─── Users ───────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT auth.uid(),
  phone_number  TEXT UNIQUE NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  middle_name   TEXT,
  email         TEXT,
  role          user_role NOT NULL DEFAULT 'customer',
  gender        gender,
  birthday      DATE,
  profile_picture TEXT,
  address       TEXT,
  pin_hash      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Rider Profiles ──────────────────────────────────────────────────
CREATE TABLE rider_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rider_id        TEXT UNIQUE NOT NULL, -- display ID like "BK-9921"
  wilaya          TEXT,
  wilaya_code     TEXT,
  bank_rib        TEXT,
  vehicle_type    vehicle_type,
  license_front_url TEXT,
  license_back_url  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- ─── Vehicles ────────────────────────────────────────────────────────
CREATE TABLE vehicles (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand                 TEXT NOT NULL,
  model                 TEXT NOT NULL,
  license_plate         TEXT NOT NULL,
  year                  TEXT NOT NULL,
  color                 TEXT NOT NULL,
  category              vehicle_category NOT NULL DEFAULT 'standard',
  gray_card_url         TEXT,
  gray_card_status      document_status NOT NULL DEFAULT 'not_uploaded',
  insurance_url         TEXT,
  insurance_status      document_status NOT NULL DEFAULT 'not_uploaded',
  driving_license_url   TEXT,
  driving_license_status document_status NOT NULL DEFAULT 'not_uploaded',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- ─── Trips ───────────────────────────────────────────────────────────
CREATE TABLE trips (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_id          TEXT UNIQUE NOT NULL,
  rider_id            UUID NOT NULL REFERENCES users(id),
  customer_id         UUID NOT NULL REFERENCES users(id),
  status              trip_status NOT NULL DEFAULT 'upcoming',
  pickup_label        TEXT NOT NULL,
  pickup_address      TEXT NOT NULL,
  pickup_lat          DOUBLE PRECISION NOT NULL,
  pickup_lng          DOUBLE PRECISION NOT NULL,
  dropoff_label       TEXT NOT NULL,
  dropoff_address     TEXT NOT NULL,
  dropoff_lat         DOUBLE PRECISION NOT NULL,
  dropoff_lng         DOUBLE PRECISION NOT NULL,
  estimated_payout    NUMERIC(10,2) NOT NULL,
  net_payout          NUMERIC(10,2) NOT NULL,
  distance_km         NUMERIC(6,2) NOT NULL,
  duration_minutes    INTEGER NOT NULL,
  cancellation_reason TEXT,
  notes               TEXT,
  penalty_amount      NUMERIC(10,2),
  dispute_status      dispute_status,
  fraud_notice        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Transactions (deposits & withdrawals) ───────────────────────────
CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            transaction_type NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id),
  agent_id        UUID REFERENCES users(id),
  rider_id        UUID REFERENCES users(id),
  amount          NUMERIC(10,2) NOT NULL,
  fees            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL,
  status          transaction_status NOT NULL DEFAULT 'pending',
  method          deposit_method,
  pending_id      UUID UNIQUE,
  offer_title     TEXT,
  offer_detail    TEXT,
  rating          SMALLINT CHECK (rating >= 1 AND rating <= 5),
  feedback        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Agent Shops ─────────────────────────────────────────────────────
CREATE TABLE agent_shops (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_name       TEXT NOT NULL,
  phone_number    TEXT,
  shop_image_url  TEXT,
  open_time       TIME NOT NULL DEFAULT '08:00',
  close_time      TIME NOT NULL DEFAULT '20:00',
  status          agent_shop_status NOT NULL DEFAULT 'closed',
  latitude        DOUBLE PRECISION NOT NULL DEFAULT 0,
  longitude       DOUBLE PRECISION NOT NULL DEFAULT 0,
  address         TEXT,
  rating          NUMERIC(2,1) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- ─── Orders ──────────────────────────────────────────────────────────
CREATE TABLE orders (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id         UUID NOT NULL REFERENCES users(id),
  rider_id            UUID REFERENCES users(id),
  store_name          TEXT NOT NULL,
  store_logo          TEXT,
  type                order_type NOT NULL,
  status              order_status NOT NULL DEFAULT 'processing',
  estimated_time      TEXT,
  subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
  delivery_fee        NUMERIC(10,2) NOT NULL DEFAULT 0,
  service_fee         NUMERIC(10,2) NOT NULL DEFAULT 0,
  discount            NUMERIC(10,2) NOT NULL DEFAULT 0,
  total               NUMERIC(10,2) NOT NULL DEFAULT 0,
  items               JSONB NOT NULL DEFAULT '[]',
  pickup_address      TEXT,
  destination_address TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Notifications ───────────────────────────────────────────────────
CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        notification_type NOT NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  is_unread   BOOLEAN NOT NULL DEFAULT true,
  payload     JSONB,
  href        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Addresses ───────────────────────────────────────────────────────
CREATE TABLE addresses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  address       TEXT NOT NULL,
  type          address_type NOT NULL DEFAULT 'other',
  latitude      DOUBLE PRECISION NOT NULL,
  longitude     DOUBLE PRECISION NOT NULL,
  street        TEXT,
  street_number TEXT,
  floor_apt     TEXT,
  directions    TEXT,
  is_default    BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Indexes ─────────────────────────────────────────────────────────
CREATE INDEX idx_users_phone ON users(phone_number);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_rider_profiles_user ON rider_profiles(user_id);
CREATE INDEX idx_vehicles_user ON vehicles(user_id);
CREATE INDEX idx_trips_rider ON trips(rider_id);
CREATE INDEX idx_trips_customer ON trips(customer_id);
CREATE INDEX idx_trips_status ON trips(status);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_transactions_agent ON transactions(agent_id);
CREATE INDEX idx_transactions_rider ON transactions(rider_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_pending ON transactions(pending_id) WHERE pending_id IS NOT NULL;
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_rider ON orders(rider_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_unread) WHERE is_unread = true;
CREATE INDEX idx_addresses_user ON addresses(user_id);
CREATE INDEX idx_agent_shops_user ON agent_shops(user_id);
CREATE INDEX idx_agent_shops_status ON agent_shops(status);
CREATE INDEX idx_agent_shops_location ON agent_shops(latitude, longitude);

-- ─── Updated_at triggers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_rider_profiles_updated_at
  BEFORE UPDATE ON rider_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_vehicles_updated_at
  BEFORE UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_trips_updated_at
  BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_agent_shops_updated_at
  BEFORE UPDATE ON agent_shops FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_addresses_updated_at
  BEFORE UPDATE ON addresses FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Row Level Security ──────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE rider_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;

-- Users can read/update their own row
CREATE POLICY users_select_own ON users FOR SELECT USING (auth.uid() = id);
CREATE POLICY users_update_own ON users FOR UPDATE USING (auth.uid() = id);

-- Rider profiles
CREATE POLICY rider_profiles_select_own ON rider_profiles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY rider_profiles_update_own ON rider_profiles FOR UPDATE USING (auth.uid() = user_id);

-- Vehicles
CREATE POLICY vehicles_select_own ON vehicles FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY vehicles_all_own ON vehicles FOR ALL USING (auth.uid() = user_id);

-- Trips — rider and customer can see their own
CREATE POLICY trips_select_own ON trips FOR SELECT
  USING (auth.uid() = rider_id OR auth.uid() = customer_id);

-- Transactions — user and agent can see
CREATE POLICY transactions_select_own ON transactions FOR SELECT
  USING (auth.uid() = user_id OR auth.uid() = agent_id);

-- Agent shops — public read for locator, owner can update
CREATE POLICY agent_shops_select_all ON agent_shops FOR SELECT USING (true);
CREATE POLICY agent_shops_update_own ON agent_shops FOR UPDATE USING (auth.uid() = user_id);

-- Orders
CREATE POLICY orders_select_own ON orders FOR SELECT
  USING (auth.uid() = customer_id OR auth.uid() = rider_id);

-- Notifications
CREATE POLICY notifications_select_own ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY notifications_update_own ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Addresses
CREATE POLICY addresses_all_own ON addresses FOR ALL USING (auth.uid() = user_id);
