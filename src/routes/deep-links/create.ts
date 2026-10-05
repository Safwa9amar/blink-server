import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, ErrorSchema, json, router } from "../../openapi";
import { createDeepLinkSchema, DeepLinkResponse } from "../../validators/deep-links";

const app = router();

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 50) || "link";
const rand = () => Math.random().toString(36).slice(2, 6);

// ─── Create ──────────────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/",
  operationId: "createDeepLink",
  tags: ["admin-deep-links"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(createDeepLinkSchema), required: true } },
  responses: {
    201: json(DeepLinkResponse, "Created"),
    400: errorResponses[400],
    401: errorResponses[401],
    409: json(ErrorSchema, "Slug already taken"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
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
    return error.code === "23505"
      ? c.json({ error: error.message }, 409)
      : c.json({ error: error.message }, 400);
  }

  return c.json({ deep_link: data }, 201);
});

export default app;
