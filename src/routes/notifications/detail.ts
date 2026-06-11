import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get single notification ─────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const notifId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("notifications")
    .select("*")
    .eq("id", notifId)
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .single();

  if (error || !data) {
    return c.json({ error: "Notification not found" }, 404);
  }

  return c.json({ notification: data });
});

export default app;
