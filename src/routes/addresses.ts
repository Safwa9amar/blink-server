import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../middleware/auth";
import { z } from "zod";

const createAddressSchema = z.object({
  label: z.string().min(1),
  address: z.string().min(1),
  type: z.enum(["home", "work", "other"]),
  latitude: z.number(),
  longitude: z.number(),
  street: z.string().optional(),
  street_number: z.string().optional(),
  floor_apt: z.string().optional(),
  directions: z.string().optional(),
  is_default: z.boolean().default(false),
});

const updateAddressSchema = createAddressSchema.partial();

const app = new Hono<AuthEnv>();

app.use("/*", auth, requireRole("customer"));

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

// ─── Create address ──────────────────────────────────────────────────
app.post("/", async (c) => {
  const user = c.get("user");
  const body = createAddressSchema.parse(await c.req.json());

  // If this is set as default, unset others
  if (body.is_default) {
    await supabaseAdmin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", user.id);
  }

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .insert({ ...body, user_id: user.id })
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ address: data }, 201);
});

// ─── Update address ──────────────────────────────────────────────────
app.patch("/:id", async (c) => {
  const user = c.get("user");
  const addressId = c.req.param("id");
  const body = updateAddressSchema.parse(await c.req.json());

  if (body.is_default) {
    await supabaseAdmin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", user.id);
  }

  const { data, error } = await supabaseAdmin
    .from("addresses")
    .update(body)
    .eq("id", addressId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error || !data) {
    return c.json({ error: "Address not found" }, 404);
  }

  return c.json({ address: data });
});

// ─── Delete address ──────────────────────────────────────────────────
app.delete("/:id", async (c) => {
  const user = c.get("user");
  const addressId = c.req.param("id");

  const { error } = await supabaseAdmin
    .from("addresses")
    .delete()
    .eq("id", addressId)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Address deleted" });
});

export default app;
