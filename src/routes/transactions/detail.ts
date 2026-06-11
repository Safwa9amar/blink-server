import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get single transaction ──────────────────────────────────────────
app.get("/:id", async (c) => {
  const user = c.get("user");
  const txId = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("transactions")
    .select("*")
    .eq("id", txId)
    .single();

  if (error || !data) {
    return c.json({ error: "Transaction not found" }, 404);
  }

  if (data.user_id !== user.id && data.agent_id !== user.id) {
    return c.json({ error: "Access denied" }, 403);
  }

  return c.json({ transaction: data });
});

export default app;
