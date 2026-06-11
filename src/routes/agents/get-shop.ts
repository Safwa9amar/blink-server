import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Agent: get own shop ─────────────────────────────────────────────
app.get("/shop", auth, requireRole("agent"), async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (error || !data) {
    return c.json({ error: "Shop not found" }, 404);
  }

  return c.json({ shop: data });
});

export default app;
