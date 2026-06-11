import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { supabaseAdmin } from "./supabase";

// Single Expo SDK client. No access token is required for the public Expo push
// service; set EXPO_ACCESS_TOKEN in env to use an authenticated project.
const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN,
});

export interface PushPayload {
  title: string;
  body: string;
  // Delivered verbatim in the notification's `data` — the app reads `type` to
  // bucket it and `href`/`url` for deep-link navigation (utils/deep-linking.ts).
  data?: Record<string, unknown>;
}

/**
 * Deliver a push notification to a set of Expo push tokens. Invalid tokens are
 * skipped; sending is chunked per the Expo SDK and failures are logged, never
 * thrown — a push send must not break the request that triggered it.
 */
export async function sendPushToTokens(
  tokens: string[],
  payload: PushPayload
): Promise<void> {
  const valid = tokens.filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) return;

  const messages: ExpoPushMessage[] = valid.map((to) => ({
    to,
    sound: "default",
    title: payload.title,
    body: payload.body,
    data: payload.data ?? {},
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const tickets: ExpoPushTicket[] = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      tickets.push(...receipts);
    } catch (err) {
      console.error("[push] chunk send failed", err);
    }
  }

  // Prune tokens Expo reports as unregistered (uninstalled / token rotated) so
  // we don't keep pushing to dead devices.
  const dead: string[] = [];
  tickets.forEach((ticket, i) => {
    if (
      ticket.status === "error" &&
      ticket.details?.error === "DeviceNotRegistered"
    ) {
      const msg = messages[i];
      if (typeof msg?.to === "string") dead.push(msg.to);
    }
  });

  if (dead.length > 0) {
    await supabaseAdmin.from("device_tokens").delete().in("token", dead);
  }
}

/** Look up every Expo push token registered for a user. */
export async function tokensForUser(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("device_tokens")
    .select("token")
    .eq("user_id", userId);
  if (error) {
    console.error("[push] failed to load device tokens", error.message);
    return [];
  }
  return (data ?? []).map((r) => r.token as string);
}
