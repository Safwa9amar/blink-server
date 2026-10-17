import { supabaseAdmin } from "../../lib/supabase";
import { detailHref } from "../../lib/notifications";
import type { UserRole } from "../../db";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  listNotificationsQuery,
  NotificationListResponse,
} from "../../validators/notifications";

const app = router();

// Flatten a recipient row (+ its embedded content) into the shape the app's feed
// expects: the content fields plus the user's own `is_unread`/`archived_at`. The
// deep-link `href` is computed here from the caller's role + the shared id (an
// explicit content `href` wins).
function flatten(r: any, role: UserRole) {
  const n = r.notifications;
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    description: n.description,
    payload: n.payload,
    href: n.href ?? detailHref(role, n.type, n.id),
    content_eng: n.content_eng,
    content_fr: n.content_fr,
    content_ar: n.content_ar,
    created_at: n.created_at,
    is_unread: r.is_unread,
    archived_at: r.archived_at,
  };
}

// ─── List notifications ──────────────────────────────────────────────
// `?filter=active` (default) → the feed (archived_at IS NULL).
// `?filter=archived`        → the archive view (archived_at IS NOT NULL).
// Only the active role's feed: an account holding several roles keeps one
// feed per role (notification_recipients.role).
const route = createRoute({
  method: "get",
  path: "/",
  operationId: "listNotifications",
  tags: ["notifications"],
  security: bearer,
  request: { query: listNotificationsQuery },
  responses: { 200: json(NotificationListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const q = c.req.valid("query");
  const page = Number(q.page ?? 1);
  const limit = Number(q.limit ?? 20);
  const archived = q.filter === "archived";
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("notification_recipients")
    .select("is_unread, archived_at, created_at, notifications(*)", {
      count: "exact",
    })
    .eq("user_id", user.id)
    .eq("role", user.role)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  query = archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null);

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  const notifications = (data ?? []).map((r) =>
    flatten(r, user.role as UserRole)
  );

  // Unread badge = unread in the role's ACTIVE feed (independent of the page/filter).
  const { count: unread } = await supabaseAdmin
    .from("notification_recipients")
    .select("notification_id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("role", user.role)
    .is("archived_at", null)
    .eq("is_unread", true);

  return c.json(
    {
      notifications,
      unread_count: unread ?? 0,
      pagination: { page, limit, total: count ?? 0 },
    },
    200
  );
});

export default app;
