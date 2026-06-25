import { boolean, integer, pgTable, real, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";

// Per-provider AI config. `ai_settings.provider` selects which one is ACTIVE.
export const aiProviderConfigs = pgTable("ai_provider_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().unique(), // openrouter | ollama | lmstudio
  model: text("model"),
  temperature: real("temperature").notNull().default(0.3),
  maxTokens: integer("max_tokens").notNull().default(600),
  reasoning: boolean("reasoning").notNull().default(false),
  apiKey: text("api_key"), // openrouter key (others null)
  baseUrl: text("base_url"), // ollama / lmstudio URL (openrouter null)
  ...timestamps,
});
