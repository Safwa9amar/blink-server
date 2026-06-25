import { Hono } from "hono";
import type { ProviderName } from "../../lib/ai";
import { buildProviderFor } from "../../lib/ai-settings";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

const PROVIDERS: ProviderName[] = ["openrouter", "ollama", "lmstudio"];

// ─── Available models for a provider ─────────────────────────────────
// ?provider=openrouter|ollama|lmstudio (defaults to openrouter). The provider
// is built from ITS OWN `ai_provider_configs` row (key/url, fallback env),
// independent of which provider is currently active. Local providers
// (ollama/lmstudio) may be offline — return [] rather than erroring.
app.get("/models", async (c) => {
  const q = c.req.query("provider");
  const provider: ProviderName = PROVIDERS.includes(q as ProviderName)
    ? (q as ProviderName)
    : "openrouter";

  try {
    const models = await (await buildProviderFor(provider)).listModels();
    return c.json({ models });
  } catch (e) {
    console.error("[ai/models] listModels failed", (e as Error).message);
    return c.json({ models: [] });
  }
});

export default app;
