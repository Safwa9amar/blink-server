import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { UUID_RE } from "./shared";

const app = new Hono<AuthEnv>();

// ─── Record a CTA click ──────────────────────────────────────────────
app.post("/:id/click", async (c) => {
  const idOrSlug = c.req.param("id");
  const lookupColumn = UUID_RE.test(idOrSlug) ? "id" : "slug";

  const { data, error } = await supabaseAdmin
    .from("news")
    .select("id, clicks")
    .eq(lookupColumn, idOrSlug)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "News post not found" }, 404);
  }

  const clicks = (data.clicks ?? 0) + 1;
  await supabaseAdmin.from("news").update({ clicks }).eq("id", data.id);

  return c.json({ message: "Click recorded", clicks });
});

export default app;
