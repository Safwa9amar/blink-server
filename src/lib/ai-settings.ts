import { supabaseAdmin } from "./supabase";

export interface AiConfig {
  provider: "openrouter" | "ollama" | "lmstudio";
  model: string | null;
  temperature: number;
  maxTokens: number;
  reasoning: boolean;
  botEnabled: boolean;
  systemPromptExtra: string | null;
}

const DEFAULTS: AiConfig = {
  provider: "openrouter",
  model: null,
  temperature: 0.3,
  maxTokens: 600,
  reasoning: false,
  botEnabled: true,
  systemPromptExtra: null,
};

let cache: { value: AiConfig; at: number } | null = null;
const TTL_MS = 15_000;

/** Read the singleton AI settings (15s cache). Falls back to defaults. */
export async function getAiConfig(): Promise<AiConfig> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { data } = await supabaseAdmin
    .from("ai_settings")
    .select(
      "provider, model, temperature, max_tokens, reasoning, bot_enabled, system_prompt_extra"
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
      }
    : DEFAULTS;
  cache = { value, at: Date.now() };
  return value;
}
