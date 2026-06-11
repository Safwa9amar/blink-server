import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { createAddressSchema } from "./shared";

const app = new Hono<AuthEnv>();

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

export default app;
