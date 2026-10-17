import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { NotificationMessageResponse } from "../../validators/notifications";

const app = router();

// ─── Mark all as read ────────────────────────────────────────────────
// Clears unread across the caller's ACTIVE feed (the badge) of their active
// role only. Archived rows and other roles' feeds are left untouched.
const route = createRoute({
  method: "patch",
  path: "/read-all",
  operationId: "markAllNotificationsRead",
  tags: ["notifications"],
  security: bearer,
  responses: { 200: json(NotificationMessageResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { error } = await supabaseAdmin
    .from("notification_recipients")
    .update({ is_unread: false })
    .eq("user_id", user.id)
    .eq("role", user.role)
    .eq("is_unread", true)
    .is("archived_at", null);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "All notifications marked as read" }, 200);
});

export default app;
