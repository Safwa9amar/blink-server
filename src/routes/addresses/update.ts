import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { updateAddressSchema } from "./shared";

const app = new Hono<AuthEnv>();

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

export default app;
