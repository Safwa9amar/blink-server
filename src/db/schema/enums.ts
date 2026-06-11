import { pgEnum } from "drizzle-orm/pg-core";

// ─── Enums ───────────────────────────────────────────────────────────
// Mirrors blink-server/supabase/migrations/00001_initial_schema.sql exactly.
// The Postgres type name (first arg) must match the existing DB type.

export const userRole = pgEnum("user_role", ["customer", "rider", "merchant", "agent"]);
export const gender = pgEnum("gender", ["male", "female"]);
export const vehicleType = pgEnum("vehicle_type", ["bicycle", "motorcycle"]);
export const vehicleCategory = pgEnum("vehicle_category", ["standard", "electric", "hybrid"]);
export const documentStatus = pgEnum("document_status", [
  "approved",
  "needs_update",
  "pending",
  "not_uploaded",
]);
export const tripStatus = pgEnum("trip_status", [
  "upcoming",
  "completed",
  "under_review",
  "canceled",
]);
export const disputeStatus = pgEnum("dispute_status", [
  "under_review",
  "pending",
  "decision_issued",
]);
export const transactionStatus = pgEnum("transaction_status", [
  "completed",
  "cancelled",
  "pending",
]);
export const transactionType = pgEnum("transaction_type", ["deposit", "withdrawal"]);
export const depositMethod = pgEnum("deposit_method", ["electronic", "agent"]);
export const orderStatus = pgEnum("order_status", [
  "searching",
  "heading_to_store",
  "preparation",
  "pickup",
  "on_the_way",
  "delivered",
  "canceled",
  "merchant_rejected",
  "processing",
]);
export const orderType = pgEnum("order_type", ["merchant", "shopper"]);
export const notificationType = pgEnum("notification_type", [
  "courier",
  "promo",
  "offer",
  "order",
  "security",
  "news",
  "alert",
  "announcement",
  "benefit",
  "deposit",
]);
export const addressType = pgEnum("address_type", ["home", "work", "other"]);
export const agentShopStatus = pgEnum("agent_shop_status", ["open", "closed"]);

// NOTE: news_status lives in ./news.ts (with its table) so it stays out of the
// baseline snapshot and ships in the additive `news` migration instead.
