import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get rider profile ───────────────────────────────────────────────
app.get("/profile", async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return c.json({ error: "Rider profile not found" }, 404);
  }

  return c.json({ profile: data });
});

export default app;
