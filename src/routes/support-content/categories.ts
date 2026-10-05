import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { SupportCategoryListResponse } from "../../validators/support-content";
import { audienceFor } from "./shared";

const app = router();

// ─── List the Help Center categories for this role ───────────────────
const route = createRoute({
  method: "get",
  path: "/categories",
  operationId: "listSupportCategories",
  tags: ["support-content"],
  security: bearer,
  responses: { 200: json(SupportCategoryListResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data, error } = await supabaseAdmin
    .from("support_categories")
    .select("*")
    .overlaps("target_roles", audienceFor(user.role))
    .order("sort", { ascending: true });

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ categories: data ?? [] }, 200);
});

export default app;
