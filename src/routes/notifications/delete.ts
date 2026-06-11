import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Dismiss a notification (soft delete) ────────────────────────────
// Hides the notification from the user's feed without removing the row — it
// stays in the DB for audit/analytics. Reads filter out `deleted_at IS NOT
// NULL`. Idempotent: dismissing an already-dismissed notification is a no-op.
app.delete("/:id", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", notifId)
    .eq("user_id", user.id)
    .is("deleted_at", null);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Notification dismissed" });
});

export default app;
