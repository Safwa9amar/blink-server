import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";
import { users } from "./users";

// Expo push tokens, one row per device. A user can have several (phone +
// tablet); the same physical device keeps one stable Expo token, so `token` is
// unique and re-registration upserts rather than duplicates. The push sender
// (src/lib/push.ts) fans a notification out to every token for the target user.
export const deviceTokens = pgTable(
  "device_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The ExpoPushToken string ("ExponentPushToken[...]").
    token: text("token").notNull().unique(),
    // "ios" | "android" | "web" — free text, mirrors expo-notifications.
    platform: text("platform"),
    ...timestamps,
  },
  (t) => [
    index("idx_device_tokens_user").on(t.userId),
    pgPolicy("device_tokens_select_own", { for: "select", using: sql`auth.uid() = user_id` }),
    pgPolicy("device_tokens_insert_own", { for: "insert", withCheck: sql`auth.uid() = user_id` }),
    pgPolicy("device_tokens_update_own", { for: "update", using: sql`auth.uid() = user_id` }),
    pgPolicy("device_tokens_delete_own", { for: "delete", using: sql`auth.uid() = user_id` }),
  ]
);
