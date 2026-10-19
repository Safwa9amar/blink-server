import { Hono } from "hono";
import { buildProviderFor, type ProviderId } from "../../lib/ai-settings";
import { DEFAULT_ASSISTANT_MODEL } from "../../lib/assistant";
import { requireStaffRole } from "../../middleware/staff-roles";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();
const PROVIDERS: ProviderId[] = ["openrouter", "ollama", "lmstudio"];
const FALLBACK = [DEFAULT_ASSISTANT_MODEL, "anthropic/claude-sonnet-5.5", "google/gemini-2.5-flash", "openai/gpt-4o-mini"];

async function openrouterToolModels(): Promise<string[]> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models?supported_parameters=tools", {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return FALLBACK;
    const json = (await res.json()) as { data?: { id?: string }[] };
    const ids = (json.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .sort();
    return ids.length ? ids : FALLBACK;
  } catch {
    return FALLBACK;
  }
}

// GET /assistant/models?provider= — tool-capable models (super_admin only). [] on error.
app.get("/models", requireStaffRole(), async (c) => {
  const q = c.req.query("provider");
  const provider: ProviderId = PROVIDERS.includes(q as ProviderId) ? (q as ProviderId) : "openrouter";
  try {
    if (provider === "openrouter") return c.json({ models: await openrouterToolModels() });
    return c.json({ models: await (await buildProviderFor(provider)).listModels() });
  } catch (e) {
    console.error("[assistant/models] failed", (e as Error).message);
    return c.json({ models: [] });
  }
});

export default app;
