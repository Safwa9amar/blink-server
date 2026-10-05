import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { NotificationMessageResponse } from "../../validators/notifications";

const app = router();

// ─── Mark as read ────────────────────────────────────────────────────
// Updates the caller's recipient row for the shared notification id.
const route = createRoute({
  method: "patch",
  path: "/{id}/read",
  operationId: "markNotificationRead",
  tags: ["notifications"],
  security: bearer,
  request: { params: IdParam },
  responses: {
    200: json(NotificationMessageResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id: notifId } = c.req.valid("param");

  const { error, count } = await supabaseAdmin
    .from("notification_recipients")
    .update({ is_unread: false }, { count: "exact" })
    .eq("notification_id", notifId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!count) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ message: "Notification marked as read" }, 200);
});

export default app;
