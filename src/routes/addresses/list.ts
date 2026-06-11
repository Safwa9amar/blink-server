import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── List addresses ──────────────────────────────────────────────────
app.get("/", async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .select("*")
    .eq("user_id", user.id)
    .order("is_default", { ascending: false });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ addresses: data });
});

export default app;
