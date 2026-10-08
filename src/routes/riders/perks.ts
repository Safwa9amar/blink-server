// Rider perks: partner benefits (read-only content) and trip challenges
// (join / give up, progress derived from trips — see lib/challenges.ts).
import { riderChallenges } from "../../lib/challenges";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  RiderBenefitListResponse,
  RiderBenefitResponse,
  RiderChallengeListResponse,
  RiderChallengeResponse,
} from "../../validators/rider-perks";

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
    operationId: "listRiderBenefits",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderBenefitListResponse), 400: errorResponses[400] },
  }),
  async (c) => {
    const { data, error } = await supabaseAdmin
      .from("rider_benefits")
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
    operationId: "getRiderBenefit",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(RiderBenefitResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { data } = await supabaseAdmin
      .from("rider_benefits")
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
    operationId: "listRiderChallenges",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderChallengeListResponse) },
  }),
  async (c) => {
    const user = c.get("user");
    return c.json({ challenges: await riderChallenges(user.id) }, 200);
  }
);

// ─── GET /challenges/{id} ────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/challenges/{id}",
    operationId: "getRiderChallenge",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(RiderChallengeResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const [challenge] = await riderChallenges(user.id, id);
    if (!challenge) return c.json({ error: "Challenge not found" }, 404);
    return c.json({ challenge }, 200);
  }
);

// ─── POST /challenges/{id}/join ──────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/challenges/{id}/join",
    operationId: "joinRiderChallenge",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam },
    responses: {
      200: json(RiderChallengeResponse),
      400: errorResponses[400],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { data: ch } = await supabaseAdmin
      .from("rider_challenges")
      .select("id, ends_at")
      .eq("id", id)
      .eq("is_active", true)
      .maybeSingle();
    if (!ch) return c.json({ error: "Challenge not found" }, 404);
    if (new Date(ch.ends_at).getTime() <= Date.now()) {
      return c.json({ error: "This challenge has ended" }, 400);
    }
    const { error } = await supabaseAdmin
      .from("rider_challenge_participants")
      .insert({ challenge_id: id, rider_id: user.id });
    if (error && error.code !== "23505") return c.json({ error: error.message }, 400);
    const [challenge] = await riderChallenges(user.id, id);
    return c.json({ challenge }, 200);
  }
);

// ─── POST /challenges/{id}/give-up ───────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/challenges/{id}/give-up",
    operationId: "giveUpRiderChallenge",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(RiderChallengeResponse), 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { data } = await supabaseAdmin
      .from("rider_challenge_participants")
      .update({ status: "gave_up", settled_at: new Date().toISOString() })
      .eq("challenge_id", id)
      .eq("rider_id", user.id)
      .eq("status", "joined")
      .select("challenge_id")
      .maybeSingle();
    if (!data) return c.json({ error: "Not taking part in this challenge" }, 404);
    const [challenge] = await riderChallenges(user.id, id);
    return c.json({ challenge }, 200);
  }
);

export default app;
