// Strategy Improvement: insights hub, Blink AI chat, saved suggestions.
import { buildProvider, getAiConfig } from "../../lib/ai-settings";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  AiChatHistoryResponse,
  MerchantStrategyResponse,
  MerchantSuggestionResponse,
  sendAiMessageSchema,
  SendAiMessageResponse,
  strategyQuerySchema,
  updateSuggestionSchema,
} from "../../validators/merchant";
import { computeStrategy, generateImprovementNotifications } from "./strategy-shared";
import { ownedStore, ownedStores } from "./shared";

const app = router();

async function resolveStore(userId: string, storeId?: string) {
  return storeId ? ownedStore(userId, storeId) : (await ownedStores(userId))[0] ?? null;
}

// ── GET /strategy ────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/strategy",
    operationId: "getMerchantStrategy",
    tags: ["merchant"],
    security: bearer,
    request: { query: strategyQuerySchema },
    responses: {
      200: json(MerchantStrategyResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const store = await resolveStore(user.id, c.req.valid("query").store_id);
    if (!store) return c.json({ error: "Store not found" }, 404);
    const strategy = await computeStrategy(user.id, store);
    // Idempotent per week — keeps the Efficiency tab fresh between cron runs.
    if (store.status === "active") void generateImprovementNotifications(user.id, store).catch(() => 0);
    return c.json(strategy as any, 200);
  }
);

// ── PATCH /suggestions/{id} ──────────────────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/suggestions/{id}",
    operationId: "updateMerchantSuggestion",
    tags: ["merchant"],
    security: bearer,
    request: { params: IdParam, body: { ...json(updateSuggestionSchema), required: true } },
    responses: {
      200: json(MerchantSuggestionResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { status } = c.req.valid("json");
    const { data, error } = await supabaseAdmin
      .from("merchant_suggestions")
      .update({ status })
      .eq("id", id)
      .eq("merchant_id", user.id)
      .select()
      .single();
    if (error || !data) return c.json({ error: "Suggestion not found" }, 404);
    return c.json({ suggestion: data }, 200);
  }
);

// ── Blink AI chat ────────────────────────────────────────────────────
async function withSuggestions(rows: Record<string, any>[]) {
  const ids = rows.map((r) => r.suggestion_id).filter(Boolean);
  const { data } = ids.length
    ? await supabaseAdmin.from("merchant_suggestions").select("*").in("id", ids)
    : { data: [] as any[] };
  const map = new Map((data ?? []).map((s) => [s.id, s]));
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    suggestion: r.suggestion_id ? map.get(r.suggestion_id) ?? null : null,
    created_at: r.created_at,
  }));
}

app.openapi(
  createRoute({
    method: "get",
    path: "/strategy/chat",
    operationId: "getMerchantAiChat",
    tags: ["merchant"],
    security: bearer,
    request: { query: strategyQuerySchema },
    responses: { 200: json(AiChatHistoryResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    const { store_id } = c.req.valid("query");
    let q = supabaseAdmin
      .from("merchant_ai_messages")
      .select("*")
      .eq("merchant_id", user.id)
      .order("created_at", { ascending: true })
      .limit(100);
    if (store_id) q = q.eq("store_id", store_id);
    const { data } = await q;
    return c.json({ messages: (await withSuggestions(data ?? [])) as any }, 200);
  }
);

const SUGGESTION_RE = /<<SUGGESTION>>([\s\S]*?)<<END>>/;

function systemPrompt(storeName: string, s: Awaited<ReturnType<typeof computeStrategy>>) {
  const m = Object.fromEntries(s.benchmark.metrics.map((x) => [x.key, `${x.you} (area ${x.area})`]));
  return [
    "You are Blink AI, a growth advisor for a merchant on Blink, an Algerian delivery marketplace.",
    "Answer in the merchant's language (Arabic, French or English), briefly and concretely, using Algerian dinars (Da).",
    `Store: ${storeName}.`,
    `This week revenue: ${s.weekly_goal.current} Da (goal ${s.weekly_goal.goal || "not set"}).`,
    `Metrics vs nearby stores: ${JSON.stringify(m)}.`,
    `Open actions: ${s.action_plan.map((a: any) => a.title).join("; ") || "none"}.`,
    `Top pricing gaps: ${s.pricing.slice(0, 3).map((p: any) => `${p.title} ${p.current_price}→${p.suggested_price}`).join("; ") || "none"}.`,
    "When you recommend ONE concrete action the merchant could apply, append it on its own line as:",
    '<<SUGGESTION>>{"title":"short title","body":"one or two sentences","kind":"bundle|pricing|promotion|hours|catalog|general"}<<END>>',
    "Never invent numbers you weren't given.",
  ].join("\n");
}

app.openapi(
  createRoute({
    method: "post",
    path: "/strategy/chat",
    operationId: "sendMerchantAiMessage",
    tags: ["merchant"],
    security: bearer,
    request: { body: { ...json(sendAiMessageSchema), required: true } },
    responses: {
      200: json(SendAiMessageResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { store_id, message } = c.req.valid("json");
    const store = await resolveStore(user.id, store_id);
    if (!store) return c.json({ error: "Store not found" }, 404);

    const { data: history } = await supabaseAdmin
      .from("merchant_ai_messages")
      .select("role, content")
      .eq("merchant_id", user.id)
      .eq("store_id", store.id)
      .order("created_at", { ascending: false })
      .limit(12);

    const { data: userMsg } = await supabaseAdmin
      .from("merchant_ai_messages")
      .insert({ merchant_id: user.id, store_id: store.id, role: "user", content: message })
      .select()
      .single();

    let reply: string;
    try {
      const cfg = await getAiConfig();
      const strategy = await computeStrategy(user.id, store);
      const res = await buildProvider(cfg).chat(
        [
          ...(history ?? []).reverse().map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
          { role: "user" as const, content: message },
        ],
        {
          systemPrompt: systemPrompt(store.name, strategy),
          model: cfg.model ?? undefined,
          temperature: cfg.temperature,
          maxTokens: cfg.maxTokens,
          reasoning: cfg.reasoning,
          logContext: { source: "merchant-strategy", userId: user.id, userRole: "merchant" } as any,
        }
      );
      reply = res.content;
    } catch (e) {
      console.error("[merchant-ai] error", (e as Error).message);
      return c.json({ error: "Blink AI is unavailable right now. Try again later." }, 400);
    }

    let suggestionId: string | null = null;
    const match = SUGGESTION_RE.exec(reply);
    if (match) {
      try {
        const s = JSON.parse(match[1].trim());
        if (s.title && s.body) {
          const { data } = await supabaseAdmin
            .from("merchant_suggestions")
            .insert({
              merchant_id: user.id,
              store_id: store.id,
              source: "chat",
              kind: String(s.kind ?? "general"),
              title: String(s.title).slice(0, 120),
              body: String(s.body).slice(0, 600),
              data: { question: message },
            })
            .select("id")
            .single();
          suggestionId = data?.id ?? null;
        }
      } catch {
        // Malformed block — keep the text reply only.
      }
    }
    const clean = reply.replace(SUGGESTION_RE, "").trim();

    const { data: botMsg } = await supabaseAdmin
      .from("merchant_ai_messages")
      .insert({
        merchant_id: user.id,
        store_id: store.id,
        role: "assistant",
        content: clean || "…",
        suggestion_id: suggestionId,
      })
      .select()
      .single();

    return c.json({ messages: (await withSuggestions([userMsg, botMsg].filter(Boolean) as any[])) as any }, 200);
  }
);

export default app;
