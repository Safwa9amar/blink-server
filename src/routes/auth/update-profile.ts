import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { updateProfileSchema } from "../../validators/auth";

const app = new Hono<AuthEnv>();

// ─── Update Profile ──────────────────────────────────────────────────
app.patch("/profile", auth, async (c) => {
  const body = updateProfileSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(body)
    .eq("id", userId)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ user: data });
});

export default app;
