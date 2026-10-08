import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AgentProfileResponse, updateAgentProfileSchema } from "../../validators/agents";

const app = router();

type Row = Record<string, any>;

/**
 * The agent's personal profile row. agent_profiles holds the auto-generated
 * display ID and business documents (editable fields like name / wilaya /
 * bank_rib live on users via /auth/profile). Create-if-missing so agents
 * created before this table existed still get a display ID.
 */
async function ensureProfile(userId: string): Promise<Row | null> {
  const { data: existing } = await supabaseAdmin
    .from("agent_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return existing;
  const { data: created } = await supabaseAdmin
    .from("agent_profiles")
    .insert({ user_id: userId })
    .select()
    .single();
  return created ?? null;
}

/** Volumes / counts of completed operations + the agent's average rating. */
async function agentStats(userId: string) {
  const { data } = await supabaseAdmin
    .from("transactions")
    .select("type, amount, rating")
    .eq("agent_id", userId)
    .eq("status", "completed");
  const stats = {
    deposits_volume: 0,
    withdrawals_volume: 0,
    deposits_count: 0,
    withdrawals_count: 0,
    rating: 0,
    ratings_count: 0,
  };
  let ratingSum = 0;
  for (const t of data ?? []) {
    if (t.type === "deposit") {
      stats.deposits_volume += Number(t.amount);
      stats.deposits_count++;
    } else {
      stats.withdrawals_volume += Number(t.amount);
      stats.withdrawals_count++;
    }
    if (t.rating != null) {
      ratingSum += t.rating;
      stats.ratings_count++;
    }
  }
  stats.rating = stats.ratings_count ? Math.round((ratingSum / stats.ratings_count) * 10) / 10 : 0;
  return stats;
}

const withDocuments = (p: Row) => ({ ...p, documents: p.documents ?? {} });

// ─── GET /profile ────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/profile",
    operationId: "getAgentProfile",
    tags: ["agents"],
    security: bearer,
    responses: {
      200: json(AgentProfileResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const [profile, stats] = await Promise.all([ensureProfile(user.id), agentStats(user.id)]);
    if (!profile) return c.json({ error: "Could not create agent profile" }, 400);
    return c.json({ profile: withDocuments(profile), stats }, 200);
  }
);

// ─── PATCH /profile ──────────────────────────────────────────────────
// Business documents. A newly uploaded scan goes (back) to `pending` review.
app.openapi(
  createRoute({
    method: "patch",
    path: "/profile",
    operationId: "updateAgentProfile",
    tags: ["agents"],
    security: bearer,
    request: { body: { ...json(updateAgentProfileSchema), required: true } },
    responses: {
      200: json(AgentProfileResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const profile = await ensureProfile(user.id);
    if (!profile) return c.json({ error: "Could not create agent profile" }, 400);

    const docs: Row = { ...(profile.documents ?? {}) };
    if (body.nif !== undefined) docs.nif = body.nif;
    if (body.nis !== undefined) docs.nis = body.nis;
    for (const side of ["front", "back"] as const) {
      const url = body[`commercial_register_${side}_url`];
      const key = `commercial_register_${side}`;
      if (url && url !== docs[key]?.url) docs[key] = { url, status: "pending", reason: null };
    }

    const { data, error } = await supabaseAdmin
      .from("agent_profiles")
      .update({ documents: docs })
      .eq("user_id", user.id)
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Update failed" }, 400);
    return c.json({ profile: withDocuments(data), stats: await agentStats(user.id) }, 200);
  }
);

export default app;
