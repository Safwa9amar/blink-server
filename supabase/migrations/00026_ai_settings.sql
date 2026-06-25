-- =====================================================================
-- Blink Server — Admin-controlled AI / support-bot configuration
-- =====================================================================
-- Authored to mirror src/db/schema/ai-settings.ts. Applied via the existing
-- `npm run db:push` pipeline. Additive only and idempotent.
--   ai_settings — a SINGLETON config row. The support bot reads the most
--     recent row (see src/lib/ai-settings.ts); the dashboard upserts it via
--     the service role. Provider API key / base URLs may be stored here (admin-
--     editable); when null the server falls back to its env defaults.
--     Service-role only: RLS is enabled with NO select/write policies, so
--     neither the mobile (anon) nor authenticated clients can read or write it.

CREATE TABLE IF NOT EXISTS "ai_settings" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "provider"            text DEFAULT 'openrouter' NOT NULL,
  "model"               text,
  "temperature"         real DEFAULT 0.3 NOT NULL,
  "max_tokens"          integer DEFAULT 600 NOT NULL,
  "reasoning"           boolean DEFAULT false NOT NULL,
  "bot_enabled"         boolean DEFAULT true NOT NULL,
  "system_prompt_extra" text,
  "openrouter_api_key"  text,
  "ollama_url"          text,
  "lmstudio_url"        text,
  "updated_by"          uuid,
  "created_at"          timestamptz DEFAULT now() NOT NULL,
  "updated_at"          timestamptz DEFAULT now() NOT NULL
);

-- Service-role only — enable RLS but add NO policies, so the anon and
-- authenticated roles can neither read nor write. The service role bypasses RLS.
ALTER TABLE "ai_settings" ENABLE ROW LEVEL SECURITY;

-- updated_at auto-bump (reuses update_updated_at() from the baseline migration).
DROP TRIGGER IF EXISTS trg_ai_settings_updated_at ON "ai_settings";
CREATE TRIGGER trg_ai_settings_updated_at
  BEFORE UPDATE ON "ai_settings" FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed exactly one default row (guarded so re-running is a no-op).
INSERT INTO ai_settings (provider, model, temperature, max_tokens, reasoning, bot_enabled)
SELECT 'openrouter', NULL, 0.3, 600, false, true
WHERE NOT EXISTS (SELECT 1 FROM ai_settings);
