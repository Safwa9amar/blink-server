import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Get Profile ─────────────────────────────────────────────────────
app.get("/profile", auth, async (c) => {
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
    const { data } = await supabaseAdmin
      .from("agent_shops")
      .select("*")
      .eq("user_id", user.id)
      .single();
    roleData = { shop: data };

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

  return c.json({ user, ...roleData });
});

export default app;
