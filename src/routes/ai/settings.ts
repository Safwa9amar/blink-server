import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// Defaults mirror the seeded row / src/lib/ai-settings.ts — returned when the
// table is somehow empty so the dashboard always has a shape to render.
const DEFAULT_SETTINGS = {
  provider: "openrouter",
  model: null as string | null,
  temperature: 0.3,
  max_tokens: 600,
  reasoning: false,
  bot_enabled: true,
  system_prompt_extra: null as string | null,
  openrouter_api_key: null as string | null,
  ollama_url: null as string | null,
  lmstudio_url: null as string | null,
};

/**
 * Never echo the raw OpenRouter key back to the dashboard. Replace it with a
 * boolean `openrouter_key_set` + `openrouter_key_last4` hint. URLs aren't
 * secret, so `ollama_url` / `lmstudio_url` pass through untouched.
 */
function maskSettings(row: Record<string, unknown>) {
  const key = typeof row.openrouter_api_key === "string" ? row.openrouter_api_key : null;
  return {
    ...row,
    openrouter_api_key: null,
    openrouter_key_set: !!key,
    openrouter_key_last4: key ? key.slice(-4) : null,
  };
}

// ─── Current AI settings (latest singleton row, or defaults) ─────────
app.get("/settings", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("ai_settings")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ settings: maskSettings(data ?? DEFAULT_SETTINGS) });
});

export default app;
