import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get vehicle ─────────────────────────────────────────────────────
app.get("/vehicle", async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("vehicles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error) {
    return c.json({ vehicle: null });
  }

  return c.json({ vehicle: data });
});

export default app;
