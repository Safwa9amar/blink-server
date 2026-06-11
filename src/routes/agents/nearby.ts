import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Public: list nearby agents (for rider agent locator) ────────────
app.get("/nearby", auth, async (c) => {
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "lat and lng query params are required" }, 400);
  }

  // For now, return all open agents — in production use PostGIS for distance
  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .select("*, users!inner(first_name, last_name, profile_picture)")
    .eq("status", "open")
    .limit(20);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ agents: data });
});

export default app;
