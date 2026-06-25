import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

const PROVIDERS = ["openrouter", "ollama", "lmstudio"] as const;
type ProviderId = (typeof PROVIDERS)[number];

// Bot-level defaults (active provider, enable flag, prompt addendum) — returned
// when `ai_settings` is somehow empty so the dashboard always has a shape.
const DEFAULT_SETTINGS = {
  provider: "openrouter" as ProviderId,
  bot_enabled: true,
  system_prompt_extra: null as string | null,
};

// Per-provider defaults — returned for any provider missing its config row.
function defaultProviderConfig(provider: ProviderId) {
  return {
    provider,
    model: null as string | null,
    temperature: 0.3,
    max_tokens: 600,
    reasoning: false,
    base_url: null as string | null,
    api_key: null as string | null,
  };
}

/**
 * Never echo a raw provider key back to the dashboard. Replace `api_key` with a
 * boolean `api_key_set` + `api_key_last4` hint. URLs aren't secret, so
 * `base_url` passes through untouched.
 */
function maskProvider(row: Record<string, unknown>) {
  const key = typeof row.api_key === "string" ? row.api_key : null;
  return {
    ...row,
    api_key: null,
    api_key_set: !!key,
    api_key_last4: key ? key.slice(-4) : null,
  };
}

// ─── Current AI settings + per-provider configs ──────────────────────
app.get("/settings", async (c) => {
  const { data: settingsRow, error: settingsErr } = await supabaseAdmin
    .from("ai_settings")
    .select("provider, bot_enabled, system_prompt_extra")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (settingsErr) {
    return c.json({ error: settingsErr.message }, 400);
  }

  const { data: providerRows, error: providersErr } = await supabaseAdmin
    .from("ai_provider_configs")
    .select("provider, model, temperature, max_tokens, reasoning, base_url, api_key");

  if (providersErr) {
    return c.json({ error: providersErr.message }, 400);
  }

  const byProvider = new Map<string, Record<string, unknown>>();
  for (const row of providerRows ?? []) byProvider.set(String(row.provider), row);

  const providers = PROVIDERS.map((p) =>
    maskProvider(byProvider.get(p) ?? defaultProviderConfig(p))
  );

  return c.json({
    settings: settingsRow ?? DEFAULT_SETTINGS,
    providers,
  });
});

export default app;
