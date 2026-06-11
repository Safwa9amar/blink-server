import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { updateDeepLinkSchema } from "../../validators/deep-links";

const app = new Hono<AuthEnv>();

// ─── Update (by id) ──────────────────────────────────────────────────
app.patch("/:id", auth, async (c) => {
  const id = c.req.param("id");
  const body = updateDeepLinkSchema.parse(await c.req.json());

  // Map camelCase input → snake_case columns; only patch provided keys.
  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.slug !== undefined) patch.slug = body.slug;
  if (body.description !== undefined) patch.description = body.description;
  if (body.role !== undefined) patch.role = body.role;
  if (body.routePath !== undefined) patch.route_path = body.routePath;
  if (body.deepLink !== undefined) patch.deep_link = body.deepLink;
  if (body.webUrl !== undefined) patch.web_url = body.webUrl;
  if (body.requiredParams !== undefined) patch.required_params = body.requiredParams;
  if (body.params !== undefined) patch.params = body.params;
  if (body.campaign !== undefined) patch.campaign = body.campaign;
  if (body.isActive !== undefined) patch.is_active = body.isActive;
  if (body.expiresAt !== undefined) patch.expires_at = body.expiresAt;

  if (Object.keys(patch).length === 0) {
    return c.json({ error: "No fields to update" }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("deep_links")
    .update(patch)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, error.code === "23505" ? 409 : 400);
  }
  if (!data) {
    return c.json({ error: "Deep link not found" }, 404);
  }

  return c.json({ deep_link: data });
});

export default app;
