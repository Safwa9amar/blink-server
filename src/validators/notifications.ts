import { z } from "zod";

// Register (upsert) an Expo push token for the authenticated user's device.
export const registerDeviceSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["ios", "android", "web"]).optional(),
});

// Unregister a device (on logout / token rotation).
export const unregisterDeviceSchema = z.object({
  token: z.string().min(1),
});

// Self-test: create a notification for the current user and push it. Handy for
// verifying the end-to-end pipeline from a device.
export const testNotificationSchema = z.object({
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
    ])
    .default("announcement"),
  title: z.string().min(1).default("Test notification"),
  description: z.string().min(1).default("This is a test push from Blink."),
  href: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// Broadcast test: same content as a self-test, but fanned out to every user in
// the target roles (one content row + a recipient row per user + a push each).
// `roles` defaults to all four so a bare POST exercises the full fan-out.
export const broadcastTestNotificationSchema = testNotificationSchema.extend({
  roles: z
    .array(z.enum(["customer", "rider", "merchant", "agent"]))
    .min(1)
    .default(["customer", "rider", "merchant", "agent"]),
});
