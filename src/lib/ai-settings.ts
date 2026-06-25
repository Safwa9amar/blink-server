import { supabaseAdmin } from "./supabase";
import { OpenRouterProvider, OllamaProvider, LMStudioProvider, type AIProvider } from "./ai";

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
export async function getAiConfig(): Promise<AiConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  const { data: settings } = await supabaseAdmin
    .from("ai_settings")
    .select("provider, bot_enabled, system_prompt, system_prompt_extra")
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
  };
  cache = { value, at: Date.now() };
  return value;
}

/** Build a provider instance from an explicit config row (fallback: env defaults). */
function buildFromProviderConfig(pc: ProviderConfig): AIProvider {
  switch (pc.provider) {
    case "ollama":
      return new OllamaProvider(pc.baseUrl ?? undefined);
    case "lmstudio":
      return new LMStudioProvider(pc.baseUrl ?? undefined);
    case "openrouter":
    default:
      return new OpenRouterProvider(pc.apiKey ?? undefined);
  }
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
 */
export async function buildProviderFor(provider: ProviderId): Promise<AIProvider> {
  const pc = await getProviderConfig(provider);
  return buildFromProviderConfig(pc);
}
