import { boolean, integer, pgTable, real, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";

// Admin-controlled AI/bot configuration (singleton — the support bot reads the
// most recent row). API KEYS ARE NOT STORED HERE — they stay in server env.
export const aiSettings = pgTable("ai_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().default("openrouter"), // openrouter | ollama | lmstudio
  model: text("model"), // null → provider default
  temperature: real("temperature").notNull().default(0.3),
  maxTokens: integer("max_tokens").notNull().default(600),
  reasoning: boolean("reasoning").notNull().default(false),
  botEnabled: boolean("bot_enabled").notNull().default(true),
  systemPromptExtra: text("system_prompt_extra"), // appended to the support system prompt
  updatedBy: uuid("updated_by"),
  ...timestamps,
});
