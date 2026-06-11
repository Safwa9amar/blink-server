import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { updateTripStatusSchema } from "../../validators/trips";

const app = new Hono<AuthEnv>();

// ─── Update trip status ──────────────────────────────────────────────
app.patch("/:id/status", auth, async (c) => {
  const user = c.get("user");
  const tripId = c.req.param("id");
  const body = updateTripStatusSchema.parse(await c.req.json());

  // Verify ownership
  const { data: existing } = await supabaseAdmin
    .from("trips")
    .select("rider_id, customer_id")
    .eq("id", tripId)
    .single();

  if (!existing || (existing.rider_id !== user.id && existing.customer_id !== user.id)) {
    return c.json({ error: "Trip not found or access denied" }, 404);
  }

  const { data, error } = await supabaseAdmin
    .from("trips")
    .update(body)
    .eq("id", tripId)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ trip: data });
});

export default app;
