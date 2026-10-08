import { supabaseAdmin } from "../../lib/supabase";
import { primaryShop } from "../agents/shared";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AuthProfileResponse, publicUser } from "../../validators/auth";

const app = router();

// ─── Get Profile ─────────────────────────────────────────────────────
const route = createRoute({
  method: "get",
  path: "/profile",
  operationId: "getAuthProfile",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  responses: {
    200: json(AuthProfileResponse),
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");

  // Attach role-specific data
  let roleData: Record<string, unknown> = {};

  if (user.role === "rider") {
    const { data } = await supabaseAdmin
      .from("rider_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { rider_profile: data };

    const { data: vehicle } = await supabaseAdmin
      .from("vehicles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData.vehicle = vehicle;
  } else if (user.role === "agent") {
    const data = await primaryShop(user.id);
    roleData = { shop: data ? { ...data, documents: data.documents ?? {} } : null };

    const { data: agentProfile } = await supabaseAdmin
      .from("agent_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData.agent_profile = agentProfile;
  } else if (user.role === "merchant") {
    const { data } = await supabaseAdmin
      .from("merchant_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { merchant_profile: data };
  } else if (user.role === "customer") {
    const { data } = await supabaseAdmin
      .from("customer_profiles")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { customer_profile: data };
  }

  return c.json({ user: publicUser(user), ...roleData }, 200);
});

export default app;
