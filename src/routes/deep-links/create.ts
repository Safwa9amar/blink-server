import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { createDeepLinkSchema } from "../../validators/deep-links";

const app = new Hono<AuthEnv>();

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "link";
const rand = () => Math.random().toString(36).slice(2, 6);

// ─── Create ──────────────────────────────────────────────────────────
app.post("/", auth, async (c) => {
  const user = c.get("user");
  const body = createDeepLinkSchema.parse(await c.req.json());
  const slug = body.slug ?? `${slugify(body.title)}-${rand()}`;

  const { data, error } = await supabaseAdmin
    .from("deep_links")
    .insert({
      slug,
      title: body.title,
      description: body.description ?? null,
      role: body.role,
      route_path: body.routePath,
      deep_link: body.deepLink,
      web_url: body.webUrl ?? null,
      required_params: body.requiredParams,
      params: body.params,
      campaign: body.campaign ?? null,
      is_active: body.isActive,
      expires_at: body.expiresAt ?? null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique_violation (slug already taken)
    return c.json({ error: error.message }, error.code === "23505" ? 409 : 400);
  }

  return c.json({ deep_link: data }, 201);
});

export default app;
