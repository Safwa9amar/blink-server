import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { NotificationMessageResponse } from "../../validators/notifications";

const app = router();

// ─── Dismiss a notification (ARCHIVE) ────────────────────────────────
// The app's "delete" never removes anything — it archives the caller's recipient
// row (`archived_at`), hiding it from the active feed while keeping it viewable
// in the archive and restorable. Only the caller's own row is touched; the shared
// content and other recipients are untouched. Idempotent.
const route = createRoute({
  method: "delete",
  path: "/{id}",
  operationId: "archiveNotification",
  tags: ["notifications"],
  security: bearer,
  request: { params: IdParam },
  responses: { 200: json(NotificationMessageResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: notifId } = c.req.valid("param");

  const { error } = await supabaseAdmin
    .from("notification_recipients")
    .update({ archived_at: new Date().toISOString() })
    .eq("notification_id", notifId)
    .eq("user_id", user.id)
    .eq("role", user.role)
    .is("archived_at", null);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Notification archived" }, 200);
});

export default app;
