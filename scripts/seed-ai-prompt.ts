// scripts/seed-ai-prompt.ts — run with: npx tsx scripts/seed-ai-prompt.ts
//
// Idempotent seed for the DB-backed bot system prompt (00029). Copies the
// built-in DEFAULT_SUPPORT_PROMPT into `ai_settings.system_prompt` on the latest
// singleton row ONLY when it's currently null/blank, so the dashboard
// (Support → AI) shows the full prompt to edit. Re-running is a no-op once set.
// Single source of truth = the TS constant (imported here), not duplicated SQL.
import "../src/config/env";
import { supabaseAdmin } from "../src/lib/supabase";
import { DEFAULT_SUPPORT_PROMPT } from "../src/lib/ai/support-prompt";

async function main() {
  const { data, error } = await supabaseAdmin
    .from("ai_settings")
    .select("id, system_prompt")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    console.log("no ai_settings row — nothing to seed.");
    return;
  }
  const cur = (data as { system_prompt?: string | null }).system_prompt;
  if (cur && cur.trim()) {
    console.log("ai_settings.system_prompt already set — skipping.");
    return;
  }
  const { error: upErr } = await supabaseAdmin
    .from("ai_settings")
    .update({ system_prompt: DEFAULT_SUPPORT_PROMPT })
    .eq("id", (data as { id: string }).id);
  if (upErr) throw upErr;
  console.log("Seeded ai_settings.system_prompt with the built-in default.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
