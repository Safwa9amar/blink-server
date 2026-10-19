import { supabaseAdmin } from "../../lib/supabase";
import type { ProviderId } from "../../lib/ai-settings";
import { DEFAULT_ASSISTANT_MODEL } from "../../lib/assistant";

export interface AssistantSettings {
  enabled: boolean;
  provider: ProviderId;
  model: string; // effective
}

const DEFAULTS: AssistantSettings = { enabled: true, provider: "openrouter", model: DEFAULT_ASSISTANT_MODEL };

/** Latest ai_settings row (by updated_at, like ai-settings.ts). Tolerates the columns missing (pre-migration). */
export async function getAssistantSettings(): Promise<AssistantSettings> {
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_settings")
      .select("assistant_enabled, assistant_provider, assistant_model")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return DEFAULTS;
    const p = data.assistant_provider;
    return {
      enabled: data.assistant_enabled ?? true,
      provider: p === "ollama" || p === "lmstudio" || p === "openrouter" ? p : "openrouter",
      model: data.assistant_model?.trim() || DEFAULT_ASSISTANT_MODEL,
    };
  } catch {
    return DEFAULTS;
  }
}
