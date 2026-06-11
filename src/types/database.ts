import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { news } from "../db/schema";

// `news` types are inferred straight from the Drizzle table (src/db/schema/news.ts)
// — the schema is the single source of truth. See NewsRow/NewsInsert/NewsUpdate below.
// Each language is its own column: content_eng / content_fr / content_ar (NewsCopy).
export type { NewsCopy } from "../db/schema/news";
export type NewsStatus = "published" | "scheduled" | "draft";

export type UserRole = "customer" | "rider" | "merchant" | "agent" | "super_admin";
export type Gender = "male" | "female";
export type VehicleType = "bicycle" | "motorcycle";
export type VehicleCategory = "standard" | "electric" | "hybrid";
export type DocumentStatus = "approved" | "needs_update" | "pending" | "not_uploaded";
export type TripStatus = "upcoming" | "completed" | "under_review" | "canceled";
export type DisputeStatus = "under_review" | "pending" | "decision_issued";
export type TransactionStatus = "completed" | "cancelled" | "pending";
export type TransactionType = "deposit" | "withdrawal";
export type DepositMethod = "electronic" | "agent";
export type OrderStatus =
  | "searching"
  | "heading_to_store"
  | "preparation"
  | "pickup"
  | "on_the_way"
  | "delivered"
  | "canceled"
  | "merchant_rejected"
  | "processing";
export type OrderType = "merchant" | "shopper";
export type NotificationType =
  | "courier"
  | "promo"
  | "offer"
  | "order"
  | "security"
  | "news"
  | "alert"
  | "announcement"
  | "benefit"
  | "deposit";
export type AddressType = "home" | "work" | "other";
export type AgentShopStatus = "open" | "closed";

// Supabase-generated types placeholder — replace after `supabase gen types`
export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserRow;
        Insert: UserInsert;
        Update: UserUpdate;
      };
      rider_profiles: {
        Row: RiderProfileRow;
        Insert: RiderProfileInsert;
        Update: RiderProfileUpdate;
      };
      vehicles: {
        Row: VehicleRow;
        Insert: VehicleInsert;
        Update: VehicleUpdate;
      };
      trips: {
        Row: TripRow;
        Insert: TripInsert;
        Update: TripUpdate;
      };
      transactions: {
        Row: TransactionRow;
        Insert: TransactionInsert;
        Update: TransactionUpdate;
      };
      agent_shops: {
        Row: AgentShopRow;
        Insert: AgentShopInsert;
        Update: AgentShopUpdate;
      };
      orders: {
        Row: OrderRow;
        Insert: OrderInsert;
        Update: OrderUpdate;
      };
      notifications: {
        Row: NotificationRow;
        Insert: NotificationInsert;
        Update: NotificationUpdate;
      };
      addresses: {
        Row: AddressRow;
        Insert: AddressInsert;
        Update: AddressUpdate;
      };
      news: {
        Row: NewsRow;
        Insert: NewsInsert;
        Update: NewsUpdate;
      };
    };
    Enums: {
      user_role: UserRole;
      gender: Gender;
      vehicle_type: VehicleType;
      trip_status: TripStatus;
      transaction_status: TransactionStatus;
      transaction_type: TransactionType;
      order_status: OrderStatus;
      notification_type: NotificationType;
      news_status: NewsStatus;
    };
  };
};

// ─── Users ───────────────────────────────────────────────────────────
export interface UserRow {
  id: string;
  phone_number: string;
  first_name: string | null;
  last_name: string | null;
  middle_name: string | null;
  email: string | null;
  role: UserRole;
  gender: Gender | null;
  birthday: string | null;
  profile_picture: string | null;
  address: string | null;
  pin_hash: string | null;
  created_at: string;
  updated_at: string;
}
export type UserInsert = Omit<UserRow, "id" | "created_at" | "updated_at">;
export type UserUpdate = Partial<UserInsert>;

// ─── Rider Profiles ──────────────────────────────────────────────────
export interface RiderProfileRow {
  id: string;
  user_id: string;
  rider_id: string; // display ID like "BK-9921"
  wilaya: string | null;
  wilaya_code: string | null;
  bank_rib: string | null;
  vehicle_type: VehicleType | null;
  license_front_url: string | null;
  license_back_url: string | null;
  created_at: string;
  updated_at: string;
}
export type RiderProfileInsert = Omit<RiderProfileRow, "id" | "created_at" | "updated_at">;
export type RiderProfileUpdate = Partial<RiderProfileInsert>;

// ─── Vehicles ────────────────────────────────────────────────────────
export interface VehicleRow {
  id: string;
  user_id: string;
  brand: string;
  model: string;
  license_plate: string;
  year: string;
  color: string;
  category: VehicleCategory;
  gray_card_url: string | null;
  gray_card_status: DocumentStatus;
  insurance_url: string | null;
  insurance_status: DocumentStatus;
  driving_license_url: string | null;
  driving_license_status: DocumentStatus;
  created_at: string;
  updated_at: string;
}
export type VehicleInsert = Omit<VehicleRow, "id" | "created_at" | "updated_at">;
export type VehicleUpdate = Partial<VehicleInsert>;

// ─── Trips ───────────────────────────────────────────────────────────
export interface TripRow {
  id: string;
  display_id: string;
  rider_id: string;
  customer_id: string;
  status: TripStatus;
  pickup_label: string;
  pickup_address: string;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_label: string;
  dropoff_address: string;
  dropoff_lat: number;
  dropoff_lng: number;
  estimated_payout: number;
  net_payout: number;
  distance_km: number;
  duration_minutes: number;
  cancellation_reason: string | null;
  notes: string | null;
  penalty_amount: number | null;
  dispute_status: DisputeStatus | null;
  fraud_notice: string | null;
  created_at: string;
  updated_at: string;
}
export type TripInsert = Omit<TripRow, "id" | "created_at" | "updated_at">;
export type TripUpdate = Partial<TripInsert>;

// ─── Transactions ────────────────────────────────────────────────────
export interface TransactionRow {
  id: string;
  type: TransactionType;
  user_id: string;        // rider or agent
  agent_id: string | null; // agent who processed it
  rider_id: string | null; // rider involved (for agent transactions)
  amount: number;
  fees: number;
  total: number;
  status: TransactionStatus;
  method: DepositMethod | null;
  pending_id: string | null;  // QR pending reference
  offer_title: string | null;
  offer_detail: string | null;
  rating: number | null;
  feedback: string | null;
  created_at: string;
  updated_at: string;
}
export type TransactionInsert = Omit<TransactionRow, "id" | "created_at" | "updated_at">;
export type TransactionUpdate = Partial<TransactionInsert>;

// ─── Agent Shops ─────────────────────────────────────────────────────
export interface AgentShopRow {
  id: string;
  user_id: string;
  shop_name: string;
  phone_number: string | null;
  shop_image_url: string | null;
  open_time: string;  // HH:mm
  close_time: string; // HH:mm
  status: AgentShopStatus;
  latitude: number;
  longitude: number;
  address: string | null;
  rating: number;
  created_at: string;
  updated_at: string;
}
export type AgentShopInsert = Omit<AgentShopRow, "id" | "created_at" | "updated_at">;
export type AgentShopUpdate = Partial<AgentShopInsert>;

// ─── Orders ──────────────────────────────────────────────────────────
export interface OrderRow {
  id: string;
  customer_id: string;
  rider_id: string | null;
  store_name: string;
  store_logo: string | null;
  type: OrderType;
  status: OrderStatus;
  estimated_time: string | null;
  subtotal: number;
  delivery_fee: number;
  service_fee: number;
  discount: number;
  total: number;
  items: OrderItem[];
  pickup_address: string | null;
  destination_address: string | null;
  created_at: string;
  updated_at: string;
}
export interface OrderItem {
  name: string;
  quantity: number;
  unit_price: number;
}
export type OrderInsert = Omit<OrderRow, "id" | "created_at" | "updated_at">;
export type OrderUpdate = Partial<OrderInsert>;

// ─── Notifications ───────────────────────────────────────────────────
export interface NotificationRow {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  description: string;
  is_unread: boolean;
  payload: Record<string, unknown> | null;
  href: string | null;
  created_at: string;
}
export type NotificationInsert = Omit<NotificationRow, "id" | "created_at">;
export type NotificationUpdate = Partial<Pick<NotificationRow, "is_unread">>;

// ─── Addresses ───────────────────────────────────────────────────────
export interface AddressRow {
  id: string;
  user_id: string;
  label: string;
  address: string;
  type: AddressType;
  latitude: number;
  longitude: number;
  street: string | null;
  street_number: string | null;
  floor_apt: string | null;
  directions: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}
export type AddressInsert = Omit<AddressRow, "id" | "created_at" | "updated_at">;
export type AddressUpdate = Partial<AddressInsert>;

// ─── News ────────────────────────────────────────────────────────────
// Inferred from the Drizzle table (src/db/schema/news.ts) — no hand-maintained
// duplicate. `mode: "string"` timestamps + `.$type<number>()` keep these aligned
// with what supabase-js / PostgREST return at runtime.
export type NewsRow = InferSelectModel<typeof news>;
export type NewsInsert = InferInsertModel<typeof news>;
export type NewsUpdate = Partial<NewsInsert>;
