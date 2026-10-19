import { supabaseAdmin } from "./supabase";
import {
  OpenRouterProvider,
  OllamaProvider,
  LMStudioProvider,
  OPENROUTER_DEFAULT_EMBED_MODEL,
  type AIProvider,
} from "./ai";
import { instrumentProvider } from "./ai-log";

export type ProviderId = "openrouter" | "ollama" | "lmstudio";

export interface AiConfig {
  // Bot-level / active-provider selection — from `ai_settings`.
  provider: ProviderId;
  botEnabled: boolean;
  systemPrompt: string | null; // full base prompt (null → built-in DEFAULT_SUPPORT_PROMPT)
  systemPromptExtra: string | null;
  // Per-provider config — from the ACTIVE provider's `ai_provider_configs` row.
  model: string | null;
  temperature: number;
  maxTokens: number;
  reasoning: boolean;
  apiKey: string | null; // active provider's credential (openrouter key)
  baseUrl: string | null; // active provider's endpoint (ollama / lmstudio url)
  // Support-bot RAG — from `ai_settings`.
  ragEnabled: boolean;
  embeddingProvider: ProviderId;
  embeddingModel: string | null; // null → embedding provider default
  ragTopK: number;
  ragMinScore: number;
}

function asProvider(v: unknown): ProviderId {
  return v === "ollama" || v === "lmstudio" || v === "openrouter" ? v : "openrouter";
}
function clampInt(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
}
function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

/** Per-provider config shape (one row of `ai_provider_configs`). */
export interface ProviderConfig {
  provider: ProviderId;
  model: string | null;
  temperature: number;
  maxTokens: number;
  reasoning: boolean;
  apiKey: string | null;
  baseUrl: string | null;
}

const PROVIDER_DEFAULTS: ProviderConfig = {
  provider: "openrouter",
  model: null,
  temperature: 0.3,
  maxTokens: 600,
  reasoning: false,
  apiKey: null,
  baseUrl: null,
};

const DEFAULTS: AiConfig = {
  provider: "openrouter",
  botEnabled: true,
  systemPrompt: null,
  systemPromptExtra: null,
  model: null,
  temperature: 0.3,
  maxTokens: 600,
  reasoning: false,
  apiKey: null,
  baseUrl: null,
  ragEnabled: false,
  embeddingProvider: "openrouter",
  embeddingModel: null,
  ragTopK: 6,
  ragMinScore: 0.3,
};

let cache: { value: AiConfig; at: number } | null = null;
const TTL_MS = 15_000;

/** Read one provider's config row (no cache — used by the models endpoint). */
export async function getProviderConfig(provider: ProviderId): Promise<ProviderConfig> {
  const { data } = await supabaseAdmin
    .from("ai_provider_configs")
    .select("provider, model, temperature, max_tokens, reasoning, api_key, base_url")
    .eq("provider", provider)
    .maybeSingle();
  if (!data) return { ...PROVIDER_DEFAULTS, provider };
  return {
    provider,
    model: data.model ?? null,
    temperature: data.temperature ?? 0.3,
    maxTokens: data.max_tokens ?? 600,
    reasoning: data.reasoning ?? false,
    apiKey: data.api_key ?? null,
    baseUrl: data.base_url ?? null,
  };
}

/**
 * Read the active AI config (15s cache). The bot-level fields (active provider,
 * bot_enabled, system_prompt_extra) come from `ai_settings`; the model/params/
 * credential come from the ACTIVE provider's `ai_provider_configs` row.
 */
export async function getAiConfig(opts?: { fresh?: boolean }): Promise<AiConfig> {
  if (!opts?.fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const { data: settings } = await supabaseAdmin
    .from("ai_settings")
    .select(
      "provider, bot_enabled, system_prompt, system_prompt_extra, rag_enabled, embedding_provider, embedding_model, rag_top_k, rag_min_score"
    )
    // Order by updated_at to match the dashboard reader/writer (which edit the
    // most-recently-updated row); avoids the two diverging on a stray 2nd row.
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!settings) {
    cache = { value: DEFAULTS, at: Date.now() };
    return DEFAULTS;
  }

  const provider = (settings.provider as ProviderId) ?? "openrouter";
  const pc = await getProviderConfig(provider);

  const value: AiConfig = {
    provider,
    botEnabled: settings.bot_enabled ?? true,
    systemPrompt: settings.system_prompt ?? null,
    systemPromptExtra: settings.system_prompt_extra ?? null,
    model: pc.model,
    temperature: pc.temperature,
    maxTokens: pc.maxTokens,
    reasoning: pc.reasoning,
    apiKey: pc.apiKey,
    baseUrl: pc.baseUrl,
    ragEnabled: settings.rag_enabled ?? false,
    embeddingProvider: asProvider(settings.embedding_provider),
    embeddingModel: settings.embedding_model?.trim() || null,
    ragTopK: clampInt(settings.rag_top_k, 1, 20, 6),
    ragMinScore: clampNum(settings.rag_min_score, 0, 1, 0.3),
  };
  cache = { value, at: Date.now() };
  return value;
}

/** Build a provider instance from an explicit config row (fallback: env defaults).
 *  Wrapped in instrumentProvider so every chat/stream lands in the AI-log buffer. */
function buildFromProviderConfig(pc: ProviderConfig): AIProvider {
  const provider =
    pc.provider === "ollama"
      ? new OllamaProvider(pc.baseUrl ?? undefined)
      : pc.provider === "lmstudio"
        ? new LMStudioProvider(pc.baseUrl ?? undefined)
        : new OpenRouterProvider(pc.apiKey ?? undefined);
  return instrumentProvider(provider);
}

/**
 * Build a provider instance using the ACTIVE provider's DB-configured credential
 * (fallback: env defaults). `cfg` already carries the active provider's
 * apiKey/baseUrl, so no extra DB read is needed.
 */
export function buildProvider(cfg: AiConfig): AIProvider {
  return buildFromProviderConfig({
    provider: cfg.provider,
    model: cfg.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    reasoning: cfg.reasoning,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
  });
}

/**
 * Build a provider instance for an ARBITRARY provider, reading THAT provider's
 * own `ai_provider_configs` row for its credential (fallback: env). Used by the
 * models endpoint, which may be asked for any provider regardless of which one
 * is active.
 *
 * `overrides.baseUrl` lets the dashboard's AI Server settings list models against
 * the URL the operator has TYPED but not yet saved (local providers only) — so the
 * model picker reflects the settings form live. Blank → the saved DB config wins.
 */
export async function buildProviderFor(
  provider: ProviderId,
  overrides?: { baseUrl?: string | null }
): Promise<AIProvider> {
  const pc = await getProviderConfig(provider);
  const baseUrl = overrides?.baseUrl?.trim();
  return buildFromProviderConfig(baseUrl ? { ...pc, baseUrl } : pc);
}

/** Provider used to embed KB chunks + queries (its own credential/url). */
export async function buildEmbeddingProvider(cfg: AiConfig): Promise<AIProvider> {
  return buildProviderFor(cfg.embeddingProvider);
}

/** Built-in default embedding model id per provider (LM Studio resolves at call time). */
export function defaultEmbeddingModel(provider: ProviderId): string {
  if (provider === "ollama") return "bge-m3";
  if (provider === "lmstudio") return "text-embedding-nomic-embed-text-v1.5";
  return OPENROUTER_DEFAULT_EMBED_MODEL;
}

let lmEmbedCache: { id: string; at: number } | null = null;

/**
 * The effective embedding model id: the configured one, else the provider default.
 * For LM Studio with no configured model, the first loaded embedding model wins
 * (matches LMStudioProvider.embed) so the id we tag rows with is the one used.
 */
export async function resolveEmbeddingModel(
  cfg: AiConfig,
  provider?: AIProvider
): Promise<string> {
  if (cfg.embeddingModel) return cfg.embeddingModel;
  if (cfg.embeddingProvider === "lmstudio") {
    if (lmEmbedCache && Date.now() - lmEmbedCache.at < 60_000) return lmEmbedCache.id;
    try {
      const p = provider ?? (await buildEmbeddingProvider(cfg));
      const list = (await p.listEmbeddingModels?.()) ?? [];
      if (list[0]) {
        lmEmbedCache = { id: list[0], at: Date.now() };
        return list[0];
      }
    } catch {
      /* fall through */
    }
  }
  return defaultEmbeddingModel(cfg.embeddingProvider);
}
