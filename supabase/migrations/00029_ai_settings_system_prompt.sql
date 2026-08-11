-- =====================================================================
-- Blink Server — ai_settings.system_prompt (DB-backed bot base prompt)
-- =====================================================================
-- Authored to mirror src/db/schema/ai-settings.ts. Applied via the existing
-- `npm run db:push` pipeline. Additive only and idempotent.
--
-- The full support-bot SYSTEM PROMPT is now editable from the dashboard
-- (Support → AI), not just an appended addendum. The template uses runtime
-- placeholders the server substitutes: {{role}}, {{lang}}, {{kb}}. When this
-- column is NULL/blank the server falls back to its built-in
-- DEFAULT_SUPPORT_PROMPT, so the bot keeps working before the row is seeded.
--
-- The default text is seeded (so the dashboard shows the full prompt to edit) by
-- scripts/seed-ai-prompt.ts, which imports the constant — keeping a single source
-- of truth rather than duplicating the prompt here in SQL.

ALTER TABLE "ai_settings" ADD COLUMN IF NOT EXISTS "system_prompt" text;

-- Refresh PostgREST's schema cache so the new column is usable immediately.
NOTIFY pgrst, 'reload schema';
