import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Restore an archived notification ────────────────────────────────
// Un-archives the caller's recipient row (clears `archived_at`), moving it back
// into the active feed. The counterpart to DELETE /:id. Idempotent.
app.post("/:id/restore", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

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

  return c.json({ message: "Notification restored" });
});

export default app;
