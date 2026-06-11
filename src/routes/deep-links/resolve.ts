import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// Fill `[param]` placeholders in the internal Expo routePath, keeping `(group)`
// segments — the form the app passes to `router.push()` / a push payload's
// `data.href` (e.g. "/(customer)/deal/[id]" + {id:"42"} → "/(customer)/deal/42").
function fillRoute(routePath: string, params: Record<string, string> | null | undefined): string {
  return routePath.replace(/\[(?:\.{3})?([^\]]+)\]/g, (whole, name: string) => {
    const v = params?.[name];
    return v != null && v !== "" ? encodeURIComponent(v) : whole;
  });
}

// ─── PUBLIC: resolve a link by slug ──────────────────────────────────
// Declared BEFORE the auth middleware so opening a link works before login.
// Returns where to send the user and records a click. Only active, unexpired
// links resolve.
app.get("/resolve/:slug", async (c) => {
  const slug = c.req.param("slug");
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("deep_links")
    .select("id, slug, title, role, route_path, deep_link, web_url, params, required_params, campaign, clicks")
    .eq("slug", slug)
    .eq("is_active", true)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Deep link not found or inactive" }, 404);
  }

  // Best-effort click count (read-modify-write — fine for an engagement counter).
  await supabaseAdmin
    .from("deep_links")
    .update({ clicks: (data.clicks ?? 0) + 1 })
    .eq("id", data.id);

  return c.json({
    link: {
      slug: data.slug,
      title: data.title,
      role: data.role,
      // `href` is the internal expo-router target (group kept, params filled) —
      // feed it straight to router.push() / a push payload's data.href.
      href: fillRoute(data.route_path, data.params),
      route_path: data.route_path,
      deep_link: data.deep_link,
      web_url: data.web_url,
      params: data.params,
      required_params: data.required_params,
      campaign: data.campaign,
    },
  });
});

export default app;
