import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Dismiss a notification (ARCHIVE) ────────────────────────────────
// The app's "delete" never removes anything — it archives the caller's recipient
// row (`archived_at`), hiding it from the active feed while keeping it viewable
// in the archive and restorable. Only the caller's own row is touched; the shared
// content and other recipients are untouched. Idempotent.
app.delete("/:id", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

  const { error } = await supabaseAdmin
    .from("notification_recipients")
    .update({ archived_at: new Date().toISOString() })
    .eq("notification_id", notifId)
    .eq("user_id", user.id)
    .is("archived_at", null);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Notification archived" });
});

export default app;
