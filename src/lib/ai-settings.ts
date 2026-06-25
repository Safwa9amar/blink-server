import { supabaseAdmin } from "./supabase";
import { OpenRouterProvider, OllamaProvider, LMStudioProvider, type AIProvider } from "./ai";

export interface AiConfig {
  provider: "openrouter" | "ollama" | "lmstudio";
  model: string | null;
  temperature: number;
  maxTokens: number;
  reasoning: boolean;
  botEnabled: boolean;
  systemPromptExtra: string | null;
  openrouterApiKey: string | null;
  ollamaUrl: string | null;
  lmstudioUrl: string | null;
}

const DEFAULTS: AiConfig = {
  provider: "openrouter",
  model: null,
  temperature: 0.3,
  maxTokens: 600,
  reasoning: false,
  botEnabled: true,
  systemPromptExtra: null,
  openrouterApiKey: null,
  ollamaUrl: null,
  lmstudioUrl: null,
};

let cache: { value: AiConfig; at: number } | null = null;
const TTL_MS = 15_000;

/** Read the singleton AI settings (15s cache). Falls back to defaults. */
export async function getAiConfig(): Promise<AiConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { data } = await supabaseAdmin
    .from("ai_settings")
    .select(
      "provider, model, temperature, max_tokens, reasoning, bot_enabled, system_prompt_extra, openrouter_api_key, ollama_url, lmstudio_url"
    )
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const value: AiConfig = data
    ? {
        provider: (data.provider as AiConfig["provider"]) ?? "openrouter",
        model: data.model ?? null,
        temperature: data.temperature ?? 0.3,
        maxTokens: data.max_tokens ?? 600,
        reasoning: data.reasoning ?? false,
        botEnabled: data.bot_enabled ?? true,
        systemPromptExtra: data.system_prompt_extra ?? null,
        openrouterApiKey: data.openrouter_api_key ?? null,
        ollamaUrl: data.ollama_url ?? null,
        lmstudioUrl: data.lmstudio_url ?? null,
      }
    : DEFAULTS;
  cache = { value, at: Date.now() };
  return value;
}

/** Build a provider instance using DB-configured key/URL (fallback: env defaults). */
export function buildProvider(cfg: AiConfig, provider = cfg.provider): AIProvider {
  switch (provider) {
    case "ollama":
      return new OllamaProvider(cfg.ollamaUrl ?? undefined);
    case "lmstudio":
      return new LMStudioProvider(cfg.lmstudioUrl ?? undefined);
    case "openrouter":
    default:
      return new OpenRouterProvider(cfg.openrouterApiKey ?? undefined);
  }
}
