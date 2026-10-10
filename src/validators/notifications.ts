import { z } from "@hono/zod-openapi";
import { deviceTokens } from "../db/schema";
import { PaginationSchema, rowSchema } from "../openapi";

// Register (upsert) an Expo push token for the authenticated user's device.
export const registerDeviceSchema = z
  .object({
    token: z.string().min(1),
    platform: z.enum(["ios", "android", "web"]).optional(),
  })
  .openapi("RegisterDeviceBody");

// Unregister a device (on logout / token rotation).
export const unregisterDeviceSchema = z
  .object({
    token: z.string().min(1),
  })
  .openapi("UnregisterDeviceBody");

// Self-test: create a notification for the current user and push it. Handy for
// verifying the end-to-end pipeline from a device.
export const testNotificationSchema = z
  .object({
    type: z
      .enum([
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
        "improvement",
        "ride",
      ])
      .default("announcement"),
    title: z.string().min(1).default("Test notification"),
    description: z.string().min(1).default("This is a test push from Blink."),
    href: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("TestNotificationBody");

// Broadcast test: same content as a self-test, but fanned out to every user in
// the target roles (one content row + a recipient row per user + a push each).
// `roles` defaults to all four so a bare POST exercises the full fan-out.
export const broadcastTestNotificationSchema = testNotificationSchema
  .extend({
    roles: z
      .array(z.enum(["customer", "rider", "merchant", "agent"]))
      .min(1)
      .default(["customer", "rider", "merchant", "agent"]),
  })
  .openapi("BroadcastTestNotificationBody");

// ─── Query / params ──────────────────────────────────────────────────

// Kept as raw strings: the handler does its own `Number(...)` coercion and
// treats any `filter` other than "archived" as the active feed.
export const listNotificationsQuery = z.object({
  page: z.string().optional().openapi({ example: "1" }),
  limit: z.string().optional().openapi({ example: "20" }),
  filter: z
    .string()
    .optional()
    .openapi({ description: '"active" (default) or "archived"', example: "active" }),
});

// ─── Response schemas ────────────────────────────────────────────────

const notificationType = z.enum([
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
  "improvement",
  "ride",
]);

// jsonb columns typed to their real shapes (rowSchema would give the generic
// JSON union). The copy object stays inline so `nullable` survives — OpenAPI
// 3.0 drops it next to a $ref.
const NotificationCopySchema = z.object({ title: z.string(), description: z.string() });
const notificationContent = {
  id: z.string().uuid(),
  type: notificationType,
  title: z.string(),
  description: z.string(),
  payload: z.record(z.string(), z.unknown()).nullable(),
  href: z.string().nullable(),
  content_eng: NotificationCopySchema.nullable(),
  content_fr: NotificationCopySchema.nullable(),
  content_ar: NotificationCopySchema.nullable(),
  created_at: z.string(),
};

/** Shared notification content row (`notifications` table, as PostgREST returns it). */
export const NotificationRowSchema = z
  .object({
    ...notificationContent,
    target_roles: z.array(z.string()).nullable(),
    created_by: z.string().uuid().nullable(),
  })
  .openapi("NotificationRow");

/** Feed item: content fields + the caller's own recipient state. `href` falls
 *  back to a role-computed deep link (null for types without a detail screen). */
export const NotificationItemSchema = z
  .object({
    ...notificationContent,
    is_unread: z.boolean(),
    archived_at: z.string().nullable(),
  })
  .openapi("NotificationItem");

export const NotificationListResponse = z
  .object({
    notifications: z.array(NotificationItemSchema),
    unread_count: z.number().int(),
    pagination: PaginationSchema,
  })
  .openapi("NotificationListResponse");

export const NotificationDetailResponse = z
  .object({ notification: NotificationItemSchema })
  .openapi("NotificationDetailResponse");

export const NotificationMessageResponse = z
  .object({ message: z.string() })
  .openapi("NotificationMessageResponse");

export const DeviceTokenSchema = rowSchema(deviceTokens, "DeviceToken");

export const DeviceResponse = z
  .object({ device: DeviceTokenSchema })
  .openapi("DeviceResponse");

export const TestNotificationResponse = z
  .object({ notification: NotificationRowSchema })
  .openapi("TestNotificationResponse");

export const BroadcastTestNotificationResponse = z
  .object({
    recipients: z.number().int(),
    roles: z.array(z.enum(["customer", "rider", "merchant", "agent"])),
  })
  .openapi("BroadcastTestNotificationResponse");
