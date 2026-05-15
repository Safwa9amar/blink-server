import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import { z } from "zod";

const updateShopSchema = z.object({
  shop_name: z.string().min(1).optional(),
  phone_number: z.string().optional(),
  open_time: z.string().optional(),
  close_time: z.string().optional(),
  status: z.enum(["open", "closed"]).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().optional(),
});

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

// ─── Agent: update shop ──────────────────────────────────────────────
app.patch("/shop", auth, requireRole("agent"), async (c) => {
  const user = c.get("user");
  const body = updateShopSchema.parse(await c.req.json());

  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .update(body)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Shop not found" }, 404);
  }

  return c.json({ shop: data });
});

export default app;
