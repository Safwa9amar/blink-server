import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { FEED_COLUMNS, UUID_RE } from "./shared";

const app = new Hono<AuthEnv>();

// ─── Get a single published post (by id or slug) — counts a view ─────
app.get("/:id", async (c) => {
  const idOrSlug = c.req.param("id");
  const lookupColumn = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabaseAdmin
    .from("news")
    .select(FEED_COLUMNS)
    .eq(lookupColumn, idOrSlug)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "News post not found" }, 404);
  }

  // Best-effort view count (read-modify-write — fine for an engagement counter).
  const views = (data.views ?? 0) + 1;
  await supabaseAdmin.from("news").update({ views }).eq("id", data.id);

  return c.json({ news: { ...data, views } });
});

export default app;
