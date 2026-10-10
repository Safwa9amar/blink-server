import { normalizeGranted } from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import type { UserRow } from "../../types/database";
import { publicUser } from "../../validators/auth";
import { primaryShop } from "../agents/shared";

/**
 * The GET /auth/profile body: the user row (pin_hash stripped, granted_roles
 * included) plus the rows of its ACTIVE role. Shared with POST
 * /auth/partner-roles and POST /auth/active-role, which answer with the
 * updated profile.
 */
export async function authProfilePayload(user: UserRow) {
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

  // The Become a Partner rider card shows this in any active role.
  const { data: riderRow } = await supabaseAdmin
    .from("rider_profiles")
    .select("verification_status")
    .eq("user_id", user.id)
    .maybeSingle();
  roleData.rider_verification_status = riderRow?.verification_status ?? null;

  return {
    user: { ...publicUser(user), granted_roles: normalizeGranted(user.granted_roles, user.role) },
    ...roleData,
  };
}
