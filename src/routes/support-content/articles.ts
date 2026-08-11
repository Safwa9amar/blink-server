import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { audienceFor } from "./shared";

const app = new Hono<AuthEnv>();

// ─── List published articles/FAQs for this role ─────────────────────
// Optional ?type=article|faq and ?category=<key> filters. All content_*
// columns are returned so the app picks the locale client-side.
app.get("/articles", async (c) => {
  const user = c.get("user");

  let query = supabaseAdmin
    .from("support_articles")
    .select("*")
    .eq("status", "published")
    .overlaps("target_roles", audienceFor(user.role))
    .order("sort", { ascending: true })
    .order("created_at", { ascending: false });

  const type = c.req.query("type");
  if (type === "article" || type === "faq") query = query.eq("type", type);

  const category = c.req.query("category");
  if (category) query = query.eq("category", category);

  const { data, error } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ articles: data ?? [] });
});

// ─── Get a single published article — counts a view ─────────────────
app.get("/articles/:id", async (c) => {
  const id = c.req.param("id");

  const { data, error } = await supabaseAdmin
    .from("support_articles")
    .select("*")
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Article not found" }, 404);
  }

  // Best-effort view count (read-modify-write — fine for an engagement counter).
  const views = (data.views ?? 0) + 1;
  await supabaseAdmin.from("support_articles").update({ views }).eq("id", data.id);

  return c.json({ article: { ...data, views } });
});

export default app;
