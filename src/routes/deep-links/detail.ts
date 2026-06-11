import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Get one (by id or slug) ─────────────────────────────────────────
app.get("/:id", auth, async (c) => {
  const idOrSlug = c.req.param("id");
  const column = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabaseAdmin
    .from("deep_links")
    .select("*")
    .eq(column, idOrSlug)
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Deep link not found" }, 404);
  }

  return c.json({ deep_link: data });
});

export default app;
