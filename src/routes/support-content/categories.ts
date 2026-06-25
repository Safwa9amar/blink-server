import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { audienceFor } from "./shared";

const app = new Hono<AuthEnv>();

// ─── List the Help Center categories for this role ───────────────────
app.get("/categories", async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("support_categories")
    .select("*")
    .overlaps("target_roles", audienceFor(user.role))
    .order("sort", { ascending: true });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ categories: data ?? [] });
});

export default app;
