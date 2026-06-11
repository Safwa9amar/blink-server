import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Mark all as read ────────────────────────────────────────────────
app.patch("/read-all", async (c) => {
  const user = c.get("user");

  const { error } = await supabaseAdmin
    .from("notifications")
    .update({ is_unread: false })
    .eq("user_id", user.id)
    .eq("is_unread", true);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "All notifications marked as read" });
});

export default app;
