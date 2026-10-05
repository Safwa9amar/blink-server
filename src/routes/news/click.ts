import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { NewsClickResponse, NewsIdParam } from "../../validators/news";
import { UUID_RE } from "./shared";

const app = router();

// ─── Record a CTA click ──────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/{id}/click",
  operationId: "trackNewsClick",
  tags: ["news"],
  security: bearer,
  request: { params: NewsIdParam },
  responses: {
    200: json(NewsClickResponse),
    400: errorResponses[400],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const { id: idOrSlug } = c.req.valid("param");
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

  return c.json({ message: "Click recorded", clicks }, 200);
});

export default app;
