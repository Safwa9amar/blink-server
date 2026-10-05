import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentProfileResponse } from "../../validators/agents";

const app = router();

// ─── Agent: get own personal profile (display ID) ────────────────────
// agent_profiles holds only the auto-generated agent_id — there's nothing to
// PATCH (editable fields live on users via /auth/profile). Create-if-missing so
// agents created before this table existed still get a display ID.
const route = createRoute({
  method: "get",
  path: "/profile",
  operationId: "getAgentProfile",
  tags: ["agents"],
  security: bearer,
  middleware: [auth, requireRole("agent")] as const,
  responses: {
    200: json(AgentProfileResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  const { data: existing } = await supabaseAdmin
    .from("agent_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (existing) {
    return c.json({ profile: existing }, 200);
  }

  const { data: created, error } = await supabaseAdmin
    .from("agent_profiles")
    .insert({ user_id: user.id })
    .select()
    .single();

  if (error || !created) {
    return c.json(
      { error: error?.message ?? "Could not create agent profile" },
      400,
    );
  }

  return c.json({ profile: created }, 200);
});

export default app;
