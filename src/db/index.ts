// Blink DB schema surface. Drizzle owns the schema (src/db/schema) and drives
// migrations via drizzle-kit. Tables + enums are re-exported here alongside
// inferred `*Row` / `*Insert` types and enum string-unions, so the rest of the
// server can `import type { NewsRow } from "../db"`. Runtime queries still go
// through @supabase/supabase-js (src/lib/supabase.ts).

import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

export * from "./schema";
export * from "./schema/news";
export * from "./schema/deep-links";
export * from "./schema/library-categories";
export * from "./schema/library-products";

import {
  addressType,
  agentShopStatus,
  depositMethod,
  disputeStatus,
  documentStatus,
  gender,
  notificationType,
  orderStatus,
  orderType,
  transactionStatus,
  transactionType,
  tripStatus,
  userRole,
  vehicleCategory,
  vehicleType,
} from "./schema/enums";
import { newsStatus } from "./schema/news";
import { scheduledNotificationStatus } from "./schema/scheduled-notifications";
import { deepLinkRole } from "./schema/deep-links";
import { libraryCategoryStatus } from "./schema/library-categories";
import { libraryProductStatus } from "./schema/library-products";
import type { addresses } from "./schema/addresses";
import type { agentShops } from "./schema/agent-shops";
import type { news } from "./schema/news";
import type { deepLinks } from "./schema/deep-links";
import type { libraryCategories } from "./schema/library-categories";
import type { libraryProducts } from "./schema/library-products";
import type { notifications } from "./schema/notifications";
import type { notificationRecipients } from "./schema/notification-recipients";
import type { scheduledNotifications } from "./schema/scheduled-notifications";
import type { deviceTokens } from "./schema/device-tokens";
import type { orders } from "./schema/orders";
import type { riderProfiles } from "./schema/rider-profiles";
import type { transactions } from "./schema/transactions";
import type { trips } from "./schema/trips";
import type { users } from "./schema/users";
import type { vehicles } from "./schema/vehicles";

// ─── Enum string-union types (parity with the old hand-written database.ts) ──
export type UserRole = (typeof userRole.enumValues)[number];
export type Gender = (typeof gender.enumValues)[number];
export type VehicleType = (typeof vehicleType.enumValues)[number];
export type VehicleCategory = (typeof vehicleCategory.enumValues)[number];
export type DocumentStatus = (typeof documentStatus.enumValues)[number];
export type TripStatus = (typeof tripStatus.enumValues)[number];
export type DisputeStatus = (typeof disputeStatus.enumValues)[number];
export type TransactionStatus = (typeof transactionStatus.enumValues)[number];
export type TransactionType = (typeof transactionType.enumValues)[number];
export type DepositMethod = (typeof depositMethod.enumValues)[number];
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type OrderType = (typeof orderType.enumValues)[number];
export type NotificationType = (typeof notificationType.enumValues)[number];
export type AddressType = (typeof addressType.enumValues)[number];
export type AgentShopStatus = (typeof agentShopStatus.enumValues)[number];
export type NewsStatus = (typeof newsStatus.enumValues)[number];
export type ScheduledNotificationStatus = (typeof scheduledNotificationStatus.enumValues)[number];
export type DeepLinkRole = (typeof deepLinkRole.enumValues)[number];
export type LibraryCategoryStatus = (typeof libraryCategoryStatus.enumValues)[number];
export type LibraryProductStatus = (typeof libraryProductStatus.enumValues)[number];

// ─── Row / Insert types, inferred from the Drizzle tables ────────────────────
export type UserRow = InferSelectModel<typeof users>;
export type UserInsert = InferInsertModel<typeof users>;
export type RiderProfileRow = InferSelectModel<typeof riderProfiles>;
export type RiderProfileInsert = InferInsertModel<typeof riderProfiles>;
export type VehicleRow = InferSelectModel<typeof vehicles>;
export type VehicleInsert = InferInsertModel<typeof vehicles>;
export type TripRow = InferSelectModel<typeof trips>;
export type TripInsert = InferInsertModel<typeof trips>;
export type TransactionRow = InferSelectModel<typeof transactions>;
export type TransactionInsert = InferInsertModel<typeof transactions>;
export type AgentShopRow = InferSelectModel<typeof agentShops>;
export type AgentShopInsert = InferInsertModel<typeof agentShops>;
export type OrderRow = InferSelectModel<typeof orders>;
export type OrderInsert = InferInsertModel<typeof orders>;
export type NotificationRow = InferSelectModel<typeof notifications>;
export type NotificationInsert = InferInsertModel<typeof notifications>;
export type NotificationRecipientRow = InferSelectModel<typeof notificationRecipients>;
export type NotificationRecipientInsert = InferInsertModel<typeof notificationRecipients>;
export type ScheduledNotificationRow = InferSelectModel<typeof scheduledNotifications>;
export type ScheduledNotificationInsert = InferInsertModel<typeof scheduledNotifications>;
export type DeviceTokenRow = InferSelectModel<typeof deviceTokens>;
export type DeviceTokenInsert = InferInsertModel<typeof deviceTokens>;
export type AddressRow = InferSelectModel<typeof addresses>;
export type AddressInsert = InferInsertModel<typeof addresses>;
export type NewsRow = InferSelectModel<typeof news>;
export type NewsInsert = InferInsertModel<typeof news>;
export type DeepLinkRow = InferSelectModel<typeof deepLinks>;
export type DeepLinkInsert = InferInsertModel<typeof deepLinks>;
export type LibraryCategoryRow = InferSelectModel<typeof libraryCategories>;
export type LibraryCategoryInsert = InferInsertModel<typeof libraryCategories>;
export type LibraryProductRow = InferSelectModel<typeof libraryProducts>;
export type LibraryProductInsert = InferInsertModel<typeof libraryProducts>;
