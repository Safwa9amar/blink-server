import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import {
  createTripSchema,
  updateTripStatusSchema,
  listTripsSchema,
} from "../validators/trips";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// ─── List trips (rider sees their trips, customer sees theirs) ───────
app.get("/", async (c) => {
  const user = c.get("user");
  const query = listTripsSchema.parse(c.req.query());
  const { page, limit, status } = query;
  const offset = (page - 1) * limit;

  const column = user.role === "rider" ? "rider_id" : "customer_id";

  let q = supabaseAdmin
    .from("trips")
    .select("*", { count: "exact" })
    .eq(column, user.id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (status) {
    q = q.eq("status", status);
  }

  const { data, error, count } = await q;

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    trips: data,
    pagination: { page, limit, total: count ?? 0 },
  });
});

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
