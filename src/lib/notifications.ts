import type {
  NotificationCopy,
  NotificationRow,
  UserRole,
} from "../db";
import { supabaseAdmin } from "./supabase";
import { sendPushToTokens, tokensForUser } from "./push";

// Detail screens look a notification up by its own id, so the deep-link a push
// carries must route to the type's detail page with the real (shared) row id.
// Mirrors the app's utils/notification-nav.ts. The role segment is per-recipient,
// so the href is computed per user (push) / at read time (feed) — never stored on
// the shared content row. Returns null for types without a dedicated detail page.
export function detailHref(
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
  // new notification id for typed notifications (so a tapped push opens the page).
  href?: string | null;
  // The role whose feed this lands in. One account can hold several roles and
  // each sees only its own notifications, so the sender names the role it is
  // notifying (never the account's active role, which may be another one).
  // Also picks the detail href's role group when `href` is omitted.
  role: UserRole;
  // Staff/sender id recorded on the content row (null for system sends).
  createdBy?: string | null;
  // When false, persist the in-app notification only (no push). Default true.
  push?: boolean;
}

// Insert the shared CONTENT row (no per-user state). Returns the new row or null.
async function insertNotificationContent(input: {
  type: NotificationRow["type"];
  title: string;
  description: string;
  payload?: Record<string, unknown> | null;
  href?: string | null;
  contentEng?: NotificationCopy | null;
  contentFr?: NotificationCopy | null;
  contentAr?: NotificationCopy | null;
  targetRoles?: UserRole[] | null;
  createdBy?: string | null;
}): Promise<NotificationRow | null> {
  const { data, error } = await supabaseAdmin
    .from("notifications")
    .insert({
      type: input.type,
      title: input.title,
      description: input.description,
      payload: input.payload ?? null,
      href: input.href ?? null,
      content_eng: input.contentEng ?? null,
      content_fr: input.contentFr ?? null,
      content_ar: input.contentAr ?? null,
      target_roles: input.targetRoles ?? null,
      created_by: input.createdBy ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    console.error("[notifications] content insert failed", error?.message);
    return null;
  }
  return data as NotificationRow;
}

// Best-effort push of one notification to all of a user's devices. The href is
// computed for THIS user's role (explicit override wins).
async function pushToUser(
  userId: string,
  notif: NotificationRow,
  role: UserRole,
  hrefOverride: string | null
): Promise<void> {
  const href = hrefOverride ?? detailHref(role, notif.type, notif.id);
  // A merchant notification about one store's product / pack names the store:
  // the app makes it current before opening the href (those screens resolve
  // ids against the current store).
  const storeId = notif.payload?.store_id;
  const tokens = await tokensForUser(userId);
  await sendPushToTokens(tokens, {
    title: notif.title,
    body: notif.description,
    data: {
      type: notif.type,
      ...(href ? { href } : {}),
      ...(typeof storeId === "string" && storeId ? { store_id: storeId } : {}),
      notificationId: notif.id,
    },
  });
}

/**
 * Persist an in-app notification for one user — a shared content row plus the
 * user's recipient row — and (unless `push: false`) deliver a push to all of
 * that user's devices. The push send is best-effort: a failed/absent device
 * must not fail the caller. Returns the content row.
 */
export async function createNotification(
  input: CreateNotificationInput
): Promise<NotificationRow | null> {
  const notif = await insertNotificationContent({
    type: input.type,
    title: input.title,
    description: input.description,
    payload: input.payload,
    href: input.href,
    contentEng: input.contentEng,
    contentFr: input.contentFr,
    contentAr: input.contentAr,
    createdBy: input.createdBy,
  });
  if (!notif) return null;

  const { error: recErr } = await supabaseAdmin
    .from("notification_recipients")
    .insert({ notification_id: notif.id, user_id: input.userId, role: input.role });
  if (recErr) {
    console.error("[notifications] recipient insert failed", recErr.message);
  }

  if (input.push !== false) {
    await pushToUser(input.userId, notif, input.role, input.href ?? null);
  }

  return notif;
}

/**
 * Create ONE notification delivered to every user who holds one of the given
 * roles (a broadcast — admin announcement, published news with `push` on, etc).
 * Writes a single content row + one recipient row per (user, targeted role they
 * hold), so an account holding two targeted roles finds it in both feeds. Pushes
 * once per user. Returns the number of users reached.
 */
export async function broadcastNotification(
  roles: UserRole[],
  input: Omit<CreateNotificationInput, "userId" | "role">
): Promise<number> {
  return (await broadcastToRoles(roles, input)).userIds.length;
}

/** broadcastNotification, also returning the users it reached (e.g. to text them too). */
export async function broadcastToRoles(
  roles: UserRole[],
  input: Omit<CreateNotificationInput, "userId" | "role">
): Promise<{ userIds: string[] }> {
  // Held, not just active: a rider currently switched to customer still gets
  // rider announcements, in the rider feed.
  const { data: users, error } = await supabaseAdmin
    .from("users")
    .select("id, role, granted_roles")
    .overlaps("granted_roles", roles);

  if (error || !users || users.length === 0) {
    if (error)
      console.error("[notifications] broadcast user lookup failed", error.message);
    return { userIds: [] };
  }

  const notif = await insertNotificationContent({
    type: input.type,
    title: input.title,
    description: input.description,
    payload: input.payload,
    href: input.href,
    contentEng: input.contentEng,
    contentFr: input.contentFr,
    contentAr: input.contentAr,
    targetRoles: roles,
    createdBy: input.createdBy,
  });
  if (!notif) return { userIds: [] };

  // The targeted roles each user holds, in `roles` order.
  const held = users.map((u) => ({
    id: u.id as string,
    active: u.role as UserRole,
    roles: roles.filter((r) => ((u.granted_roles ?? []) as string[]).includes(r)),
  }));

  // One recipient row per user and held targeted role (bulk).
  const { error: recErr } = await supabaseAdmin
    .from("notification_recipients")
    .insert(
      held.flatMap((u) =>
        u.roles.map((role) => ({ notification_id: notif.id, user_id: u.id, role }))
      )
    );
  if (recErr) {
    console.error("[notifications] broadcast recipients insert failed", recErr.message);
    return { userIds: [] };
  }

  // One push per device owner, opening the active role's copy when it was
  // targeted (else the first targeted role: the app offers to switch).
  if (input.push !== false) {
    await Promise.all(
      held.map((u) =>
        pushToUser(
          u.id,
          notif,
          u.roles.includes(u.active) ? u.active : u.roles[0],
          input.href ?? null
        )
      )
    );
  }

  return { userIds: held.map((u) => u.id) };
}
