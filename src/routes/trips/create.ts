import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../../middleware/auth";
import { createTripSchema } from "../../validators/trips";

const app = new Hono<AuthEnv>();

// ─── Create trip (internal/admin) ────────────────────────────────────
app.post("/", auth, requireRole("rider"), async (c) => {
  const body = createTripSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const displayId = `BK-${Math.floor(1000 + Math.random() * 9000)}`;

  const { data, error } = await supabaseAdmin
    .from("trips")
    .insert({
      ...body,
      rider_id: userId,
      display_id: displayId,
      status: "upcoming",
      net_payout: body.estimated_payout,
    })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ trip: data }, 201);
});

export default app;
