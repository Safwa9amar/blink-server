import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { listDeepLinksSchema } from "../../validators/deep-links";

const app = new Hono<AuthEnv>();

// ─── List (filter + search + paginate) ───────────────────────────────
app.get("/", auth, async (c) => {
  const { page, limit, role, campaign, active, q } = listDeepLinksSchema.parse(c.req.query());
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("deep_links")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (role) query = query.eq("role", role);
  if (campaign) query = query.eq("campaign", campaign);
  if (active) query = query.eq("is_active", active === "true");
  if (q) query = query.or(`slug.ilike.%${q}%,title.ilike.%${q}%`);

  const { data, error, count } = await query;
  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({
    deep_links: data ?? [],
    pagination: { page, limit, total: count ?? 0 },
  });
});

export default app;
