import { supabaseAdmin } from "../../lib/supabase";
import { detailHref } from "../../lib/notifications";
import type { UserRole } from "../../db";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { NotificationDetailResponse } from "../../validators/notifications";

const app = router();

// ─── Get single notification ─────────────────────────────────────────
// Keyed by the shared notification id; scoped to the caller via their recipient
// row (404 if they never received it). Returns content + their is_unread/archived.
const route = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "getNotification",
  tags: ["notifications"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(NotificationDetailResponse), 404: errorResponses[404] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: notifId } = c.req.valid("param");

  const { data, error } = await supabaseAdmin
    .from("notification_recipients")
    .select("is_unread, archived_at, notifications(*)")
    .eq("notification_id", notifId)
    .eq("user_id", user.id)
    .single();

  if (error || !data || !(data as any).notifications) {
    return c.json({ error: "Notification not found" }, 404);
  }

  const n = (data as any).notifications;
  return c.json(
    {
      notification: {
        id: n.id,
        type: n.type,
        title: n.title,
        description: n.description,
        payload: n.payload,
        href: n.href ?? detailHref(user.role as UserRole, n.type, n.id),
        content_eng: n.content_eng,
        content_fr: n.content_fr,
        content_ar: n.content_ar,
        created_at: n.created_at,
        is_unread: (data as any).is_unread,
        archived_at: (data as any).archived_at,
      },
    },
    200
  );
});

export default app;
