import type {
  NotificationCopy,
  NotificationInsert,
  NotificationRow,
  UserRole,
} from "../db";
import { supabaseAdmin } from "./supabase";
import { sendPushToTokens, tokensForUser } from "./push";

// Detail screens look a notification up by its own id, so the deep-link a push
// carries must route to the type's detail page with the real row id. Mirrors
// the app's utils/notification-nav.ts. Returns null for types without a
// dedicated detail page (the caller keeps any explicit href instead).
function detailHref(
  role: UserRole,
  type: NotificationRow["type"],
  id: string
): string | null {
  const base = `/(${role})/notifications`;
  switch (type) {
    case "offer":
      return `${base}/offers/${id}`;
    case "benefit":
      return `${base}/benefits/${id}`;
    case "deposit":
      return `${base}/bonuses/${id}`;
    case "alert":
    case "security":
      return `${base}/${id}`;
    default:
      return null;
  }
}

export interface CreateNotificationInput {
  userId: string;
  type: NotificationRow["type"];
  title: string;
  description: string;
  // Typed-variant payload (offer / news / benefit / deposit) — stored as JSONB
  // and round-tripped verbatim to the app's AppNotification.payload.
  payload?: Record<string, unknown> | null;
  // Localized copy ({ title, description }) per language. `title`/`description`
  // above stay the canonical/English fallback; these are stored verbatim and the
  // app picks the device language, falling back to title/description.
  contentEng?: NotificationCopy | null;
  contentFr?: NotificationCopy | null;
  contentAr?: NotificationCopy | null;
  // Internal routePath ("/(rider)/notifications/offers/123") for deep linking.
  // When omitted, a detail-page href is derived from the recipient's role + the
  // new row id for typed notifications (so a tapped push opens the right page).
  href?: string | null;
  // Recipient's role — used only to derive the detail href when `href` is
  // omitted. Looked up if not supplied (broadcast already knows it).
  role?: UserRole;
  // When false, persist the in-app notification only (no push). Default true.
  push?: boolean;
}

/**
 * Persist an in-app notification for one user and (unless `push: false`) deliver
 * a push to all of that user's registered devices. The push send is
 * best-effort — a failed/absent device must not fail the caller.
 */
export async function createNotification(
  input: CreateNotificationInput
): Promise<NotificationRow | null> {
  const row: NotificationInsert = {
    userId: input.userId,
    type: input.type,
    title: input.title,
    description: input.description,
    payload: input.payload ?? null,
    href: input.href ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from("notifications")
    .insert({
      user_id: row.userId,
      type: row.type,
      title: row.title,
      description: row.description,
      payload: row.payload,
      href: row.href,
      content_eng: input.contentEng ?? null,
      content_fr: input.contentFr ?? null,
      content_ar: input.contentAr ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[notifications] insert failed", error?.message);
    return null;
  }

  // Resolve the deep-link href: explicit input wins; otherwise derive the
  // type's detail page from the recipient's role + the new row id.
  let href = input.href ?? null;
  if (!href) {
    let role = input.role;
    if (!role) {
      const { data: u } = await supabaseAdmin
        .from("users")
        .select("role")
        .eq("id", input.userId)
        .single();
      role = (u?.role as UserRole) ?? undefined;
    }
    if (role) href = detailHref(role, input.type, data.id);
  }

  // Persist the derived href so in-app and push-tap navigation agree.
  if (href && href !== data.href) {
    await supabaseAdmin.from("notifications").update({ href }).eq("id", data.id);
    data.href = href;
  }

  if (input.push !== false) {
    const tokens = await tokensForUser(input.userId);
    await sendPushToTokens(tokens, {
      title: input.title,
      body: input.description,
      data: {
        type: input.type,
        ...(href ? { href } : {}),
        notificationId: data.id,
      },
    });
  }

  return data as NotificationRow;
}

/**
 * Create the same notification for every user in the given roles (a broadcast,
 * e.g. an admin announcement or a published news post with `push` on). Returns
 * the number of recipients. Pushes are sent per-user inside createNotification.
 */
export async function broadcastNotification(
  roles: UserRole[],
  input: Omit<CreateNotificationInput, "userId">
): Promise<number> {
  const { data: users, error } = await supabaseAdmin
    .from("users")
    .select("id, role")
    .in("role", roles);

  if (error || !users) {
    console.error("[notifications] broadcast user lookup failed", error?.message);
    return 0;
  }

  await Promise.all(
    users.map((u) =>
      createNotification({
        ...input,
        userId: u.id as string,
        role: u.role as UserRole,
      })
    )
  );

  return users.length;
}
