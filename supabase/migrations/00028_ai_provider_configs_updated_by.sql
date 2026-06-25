-- =====================================================================
-- Blink Server — ai_provider_configs.updated_by (audit column)
-- =====================================================================
-- Authored to mirror src/db/schema/ai-provider-configs.ts. Applied via the
-- existing `npm run db:push` pipeline. Additive only and idempotent.
--
-- The dashboard "AI Server Settings" panel records WHO last edited each
-- provider's config (same audit field `ai_settings.updated_by` already carries).
-- 00027 created `ai_provider_configs` without it, so the dashboard upsert failed
-- with: "Could not find the 'updated_by' column of 'ai_provider_configs' in the
-- schema cache". Add the nullable column to close that gap.

ALTER TABLE "ai_provider_configs" ADD COLUMN IF NOT EXISTS "updated_by" uuid;

-- Refresh PostgREST's schema cache immediately so the new column is usable
-- without waiting for the periodic reload (this is what the error referenced).
NOTIFY pgrst, 'reload schema';
