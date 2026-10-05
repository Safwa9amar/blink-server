import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { NotificationMessageResponse } from "../../validators/notifications";

const app = router();

// ─── Restore an archived notification ────────────────────────────────
// Un-archives the caller's recipient row (clears `archived_at`), moving it back
// into the active feed. The counterpart to DELETE /:id. Idempotent.
const route = createRoute({
  method: "post",
  path: "/{id}/restore",
  operationId: "restoreNotification",
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
    .update({ archived_at: null }, { count: "exact" })
    .eq("notification_id", notifId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!count) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ message: "Notification restored" }, 200);
});

export default app;
