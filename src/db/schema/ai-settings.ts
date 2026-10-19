import { boolean, integer, pgTable, real, text, uuid } from "drizzle-orm/pg-core";
import { timestamps } from "./_shared";

// Admin-controlled AI/bot configuration (singleton — the support bot reads the
// most recent row). Provider API key / base URLs may be stored here (admin-
// editable); when null the server falls back to its env defaults.
export const aiSettings = pgTable("ai_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  provider: text("provider").notNull().default("openrouter"), // openrouter | ollama | lmstudio
  model: text("model"), // null → provider default
  temperature: real("temperature").notNull().default(0.3),
  maxTokens: integer("max_tokens").notNull().default(600),
  reasoning: boolean("reasoning").notNull().default(false),
  botEnabled: boolean("bot_enabled").notNull().default(true),
  systemPrompt: text("system_prompt"), // full base prompt (null → built-in DEFAULT_SUPPORT_PROMPT)
  systemPromptExtra: text("system_prompt_extra"), // appended after the base system prompt
  // Provider credentials / endpoints — null → fall back to server env.
  openrouterApiKey: text("openrouter_api_key"),
  ollamaUrl: text("ollama_url"),
  lmstudioUrl: text("lmstudio_url"),
  // Support-bot RAG (hybrid pgvector + keyword retrieval) — see support_kb_chunks.
  ragEnabled: boolean("rag_enabled").notNull().default(false),
  embeddingProvider: text("embedding_provider").notNull().default("openrouter"),
  embeddingModel: text("embedding_model"), // null → embedding provider default
  ragTopK: integer("rag_top_k").notNull().default(6),
  ragMinScore: real("rag_min_score").notNull().default(0.3),
  // Staff AI assistant (dashboard chat) — 20261019220000_staff_assistant.sql.
  assistantEnabled: boolean("assistant_enabled").notNull().default(true),
  assistantProvider: text("assistant_provider").notNull().default("openrouter"),
  assistantModel: text("assistant_model"), // null → server default
  updatedBy: uuid("updated_by"),
  ...timestamps,
});
