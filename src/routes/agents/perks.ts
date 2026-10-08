// Agent perks: partner benefits (read-only content) and operation challenges
// (join / give up, progress derived from processed operations — see
// lib/agent-challenges.ts). Won rewards are credited against dues.
import { agentChallenges } from "../../lib/agent-challenges";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  AgentBenefitListResponse,
  AgentBenefitResponse,
  AgentChallengeListResponse,
  AgentChallengeResponse,
} from "../../validators/agents";

const app = router();

type Row = Record<string, any>;
const toBenefit = (b: Row) => ({
  id: b.id,
  partner_name: b.partner_name,
  offer_text: b.offer_text,
  offer_title: b.offer_title ?? b.offer_text,
  subtext: b.subtext ?? null,
  category: b.category,
  image_url: b.image_url ?? null,
  about_text: b.about_text ?? null,
  redeem_steps: b.redeem_steps ?? [],
  terms: b.terms ?? [],
  phone: b.phone ?? null,
  location: b.location ?? null,
  valid_until: b.valid_until ?? null,
});

const notExpired = (b: Row) => !b.valid_until || new Date(b.valid_until).getTime() > Date.now();

// ─── GET /benefits ───────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/benefits",
    operationId: "listAgentBenefits",
    tags: ["agents"],
    security: bearer,
    responses: { 200: json(AgentBenefitListResponse), 400: errorResponses[400] },
  }),
  async (c) => {
    const { data, error } = await supabaseAdmin
      .from("agent_benefits")
      .select("*")
      .eq("is_active", true)
      .order("sort_order", { ascending: true });
    if (error) return c.json({ error: error.message }, 400);
    return c.json({ benefits: (data ?? []).filter(notExpired).map(toBenefit) }, 200);
  }
);

// ─── GET /benefits/{id} ──────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/benefits/{id}",
    operationId: "getAgentBenefit",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(AgentBenefitResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { data } = await supabaseAdmin
      .from("agent_benefits")
      .select("*")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (!data) return c.json({ error: "Benefit not found" }, 404);
    return c.json({ benefit: toBenefit(data) }, 200);
  }
);

// ─── GET /challenges ─────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/challenges",
    operationId: "listAgentChallenges",
    tags: ["agents"],
    security: bearer,
    responses: { 200: json(AgentChallengeListResponse) },
  }),
  async (c) => {
    const user = c.get("user");
    return c.json({ challenges: await agentChallenges(user.id) }, 200);
  }
);

// ─── GET /challenges/{id} ────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/challenges/{id}",
    operationId: "getAgentChallenge",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(AgentChallengeResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const [challenge] = await agentChallenges(user.id, id);
    if (!challenge) return c.json({ error: "Challenge not found" }, 404);
    return c.json({ challenge }, 200);
  }
);

// ─── POST /challenges/{id}/join ──────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/challenges/{id}/join",
    operationId: "joinAgentChallenge",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(AgentChallengeResponse),
      400: errorResponses[400],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { data: ch } = await supabaseAdmin
      .from("agent_challenges")
      .select("id, ends_at")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (!ch) return c.json({ error: "Challenge not found" }, 404);
    if (new Date(ch.ends_at).getTime() <= Date.now()) {
      return c.json({ error: "This challenge has ended" }, 400);
    }
    const { error } = await supabaseAdmin
      .from("agent_challenge_participants")
      .insert({ challenge_id: id, agent_id: user.id });
    if (error && error.code !== "23505") return c.json({ error: error.message }, 400);
    const [challenge] = await agentChallenges(user.id, id);
    return c.json({ challenge }, 200);
  }
);

// ─── POST /challenges/{id}/give-up ───────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/challenges/{id}/give-up",
    operationId: "giveUpAgentChallenge",
    tags: ["agents"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(AgentChallengeResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { data } = await supabaseAdmin
      .from("agent_challenge_participants")
      .update({ status: "gave_up", settled_at: new Date().toISOString() })
      .eq("challenge_id", id)
      .eq("agent_id", user.id)
      .eq("status", "joined")
      .select("challenge_id")
      .maybeSingle();
    if (!data) return c.json({ error: "Not taking part in this challenge" }, 404);
    const [challenge] = await agentChallenges(user.id, id);
    return c.json({ challenge }, 200);
  }
);

export default app;
