import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get single trip ─────────────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const tripId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .single();

  if (error || !data) {
    return c.json({ error: "Trip not found" }, 404);
  }

  // Ensure user owns this trip
  if (data.rider_id !== user.id && data.customer_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ trip: data });
});

export default app;
