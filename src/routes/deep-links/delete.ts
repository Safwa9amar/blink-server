import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Delete (by id) ──────────────────────────────────────────────────
app.delete("/:id", auth, async (c) => {
  const id = c.req.param("id");

  const { error } = await supabaseAdmin.from("deep_links").delete().eq("id", id);
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Deep link deleted" });
});

export default app;
