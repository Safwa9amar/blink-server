// Strategy Improvement: insights hub, Blink AI chat, saved suggestions.
import { buildProvider, getAiConfig } from "../../lib/ai-settings";
import { buildAdvisorPrompt, buildAdvisorTurn, parseAdvisorReply, replayAssistant } from "../../lib/merchant-ai";
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
import { buildStrategy, computeStrategy, generateImprovementNotifications } from "./strategy-shared";
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

/** Room for a full answer + suggestion block, whatever the admin's support-bot cap. */
const ADVISOR_MIN_TOKENS = 1200;
/** Recent messages sent back as context; each clipped so one long reply can't crowd out the store data. */
const HISTORY_TURNS = 10;
const HISTORY_MAX_CHARS = 1200;
/** Two attempts at most stay under the app's 50s timeout for this call (hooks/use-merchant-strategy). */
const ATTEMPT_TIMEOUT_MS = 20_000;
/** Free and fast on the advisor prompt (2026-10 benchmark); a paid one needs OpenRouter credits. */
const OPENROUTER_FALLBACK_MODEL =
  process.env.MERCHANT_AI_FALLBACK_MODEL || "nvidia/nemotron-3.5-lightning:free";

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
    const askedAt = new Date().toISOString();

    let parsed: ReturnType<typeof parseAdvisorReply> | null = null;
    try {
      const [history, cfg, { strategy, insights }] = await Promise.all([
        supabaseAdmin
          .from("merchant_ai_messages")
          .select("*")
          .eq("merchant_id", user.id)
          .eq("store_id", store.id)
          .order("created_at", { ascending: false })
          .limit(HISTORY_TURNS)
          .then(({ data }) => withSuggestions((data ?? []).reverse())),
        getAiConfig(),
        buildStrategy(user.id, store),
      ]);
      const provider = buildProvider(cfg);
      const advisor = {
        storeName: store.name,
        categories: (store.category_slugs as string[] | null) ?? [],
        now: new Date(),
        strategy,
        insights,
      };
      const systemPrompt = buildAdvisorPrompt(advisor);
      const messages = [
        ...history.map((h) => ({
          role: h.role as "user" | "assistant",
          content:
            h.role === "assistant"
              ? replayAssistant(h.content.slice(0, HISTORY_MAX_CHARS), h.suggestion)
              : h.content.slice(0, HISTORY_MAX_CHARS),
        })),
        { role: "user" as const, content: buildAdvisorTurn(advisor, message) },
      ];
      const ask = async (model: string | undefined, maxTokens: number) => {
        try {
          const res = await provider.chat(messages, {
            systemPrompt,
            model,
            // Grounded numbers over creativity, whatever the support bot uses.
            temperature: Math.min(cfg.temperature, 0.5),
            maxTokens,
            // Thinking eats the token budget; on a reasoning model it can leave
            // only the chain-of-thought, which must never reach the merchant.
            reasoning: false,
            timeoutMs: ATTEMPT_TIMEOUT_MS,
            maxRetries: 0,
            logContext: { source: "merchant-strategy", userId: user.id, userRole: "merchant" },
          });
          if (res.reasoningOnly) return null;
          const out = parseAdvisorReply(res.content);
          return out.text ? out : null;
        } catch (e) {
          console.error(`[merchant-ai] ${model ?? "default model"}:`, (e as Error).message);
          return null;
        }
      };
      const budget = Math.max(cfg.maxTokens, ADVISOR_MIN_TOKENS);
      // The admin's model first; free models stall, 429 or 502 often, so fall
      // back once (local providers: their default loaded model).
      const fallback = cfg.provider === "openrouter" ? OPENROUTER_FALLBACK_MODEL : undefined;
      parsed = (await ask(cfg.model ?? undefined, budget)) ?? (await ask(fallback, budget));
    } catch (e) {
      console.error("[merchant-ai] error", (e as Error).message);
    }
    if (!parsed) return c.json({ error: "Blink AI is unavailable right now. Try again later." }, 400);

    let suggestionId: string | null = null;
    if (parsed.suggestion) {
      const { data } = await supabaseAdmin
        .from("merchant_suggestions")
        .insert({
          merchant_id: user.id,
          store_id: store.id,
          source: "chat",
          kind: parsed.suggestion.kind,
          title: parsed.suggestion.title,
          body: parsed.suggestion.body,
          data: { question: message },
        })
        .select("id")
        .single();
      suggestionId = data?.id ?? null;
    }

    // Saved only once answered, so a failed attempt leaves no orphan question.
    const { data: saved } = await supabaseAdmin
      .from("merchant_ai_messages")
      .insert([
        { merchant_id: user.id, store_id: store.id, role: "user", content: message, created_at: askedAt },
        {
          merchant_id: user.id,
          store_id: store.id,
          role: "assistant",
          content: parsed.text,
          suggestion_id: suggestionId,
          created_at: new Date().toISOString(),
        },
      ])
      .select();
    const rows = [...(saved ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));

    return c.json({ messages: (await withSuggestions(rows)) as any }, 200);
  }
);

export default app;
