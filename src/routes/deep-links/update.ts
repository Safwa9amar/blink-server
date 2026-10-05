import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, ErrorSchema, IdParam, json, router } from "../../openapi";
import { DeepLinkResponse, updateDeepLinkSchema } from "../../validators/deep-links";

const app = router();

// ─── Update (by id) ──────────────────────────────────────────────────
const route = createRoute({
  method: "patch",
  path: "/{id}",
  operationId: "updateDeepLink",
  tags: ["admin-deep-links"],
  security: bearer,
  middleware: [auth] as const,
  request: { params: IdParam, body: { ...json(updateDeepLinkSchema), required: true } },
  responses: {
    200: json(DeepLinkResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
    409: json(ErrorSchema, "Slug already taken"),
  },
});

app.openapi(route, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

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
    return error.code === "23505"
      ? c.json({ error: error.message }, 409)
      : c.json({ error: error.message }, 400);
  }
  if (!data) {
    return c.json({ error: "Deep link not found" }, 404);
  }

  return c.json({ deep_link: data }, 200);
});

export default app;
