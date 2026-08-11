-- =====================================================================
-- Blink Server — Per-provider AI config (ai_provider_configs)
-- =====================================================================
-- Authored to mirror src/db/schema/ai-provider-configs.ts. Applied via the
-- existing `npm run db:push` pipeline. Additive only and idempotent.
--   ai_provider_configs — ONE row per provider (openrouter | ollama |
--     lmstudio), holding that provider's model/params/credential. The bot
--     reads the row whose `provider` matches the ACTIVE provider selected by
--     `ai_settings.provider` (see src/lib/ai-settings.ts).
--     Service-role only: RLS is enabled with NO select/write policies, so
--     neither the mobile (anon) nor authenticated clients can read or write it.
--
-- NOTE: `ai_settings` columns are intentionally NOT dropped here — they stay
-- for safety. The new code simply stops reading the moved per-provider fields;
-- `ai_settings` now effectively holds only `provider` (the ACTIVE provider),
-- `bot_enabled`, and `system_prompt_extra`.

CREATE TABLE IF NOT EXISTS "ai_provider_configs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider"    text NOT NULL UNIQUE,
  "model"       text,
  "temperature" real DEFAULT 0.3 NOT NULL,
  "max_tokens"  integer DEFAULT 600 NOT NULL,
  "reasoning"   boolean DEFAULT false NOT NULL,
  "api_key"     text,
  "base_url"    text,
  "created_at"  timestamptz DEFAULT now() NOT NULL,
  "updated_at"  timestamptz DEFAULT now() NOT NULL
);

-- Service-role only — enable RLS but add NO policies, so the anon and
-- authenticated roles can neither read nor write. The service role bypasses RLS.
ALTER TABLE "ai_provider_configs" ENABLE ROW LEVEL SECURITY;

-- updated_at auto-bump (reuses update_updated_at() from the baseline migration).
DROP TRIGGER IF EXISTS trg_ai_provider_configs_updated_at ON "ai_provider_configs";
CREATE TRIGGER trg_ai_provider_configs_updated_at
  BEFORE UPDATE ON "ai_provider_configs" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed one row per provider, copying the current values out of the existing
-- ai_settings singleton so the admin's already-saved OpenRouter key + model
-- (and any custom local URLs) survive the move. Guarded with ON CONFLICT so
-- re-running is a no-op.
INSERT INTO ai_provider_configs (provider, model, temperature, max_tokens, reasoning, api_key, base_url)
SELECT 'openrouter', s.model, s.temperature, s.max_tokens, s.reasoning, s.openrouter_api_key, NULL
FROM ai_settings s ORDER BY s.created_at DESC LIMIT 1
ON CONFLICT (provider) DO NOTHING;

INSERT INTO ai_provider_configs (provider, base_url)
SELECT 'ollama', s.ollama_url FROM ai_settings s ORDER BY s.created_at DESC LIMIT 1
ON CONFLICT (provider) DO NOTHING;

INSERT INTO ai_provider_configs (provider, base_url)
SELECT 'lmstudio', s.lmstudio_url FROM ai_settings s ORDER BY s.created_at DESC LIMIT 1
ON CONFLICT (provider) DO NOTHING;

-- Fallbacks in case ai_settings was empty (no row to copy from above).
INSERT INTO ai_provider_configs (provider) VALUES ('openrouter') ON CONFLICT (provider) DO NOTHING;
INSERT INTO ai_provider_configs (provider) VALUES ('ollama') ON CONFLICT (provider) DO NOTHING;
INSERT INTO ai_provider_configs (provider) VALUES ('lmstudio') ON CONFLICT (provider) DO NOTHING;
