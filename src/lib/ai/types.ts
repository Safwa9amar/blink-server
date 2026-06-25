import type OpenAI from "openai";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIResponse {
  content: string;
  model: string;
  provider: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse>;
  streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>;
  listModels(): Promise<string[]>;
  getClient?(): OpenAI;
  resolveModel?(model?: string): Promise<string>;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  /** LM Studio only: idle TTL (seconds) before a JIT-loaded model is unloaded. */
  ttl?: number;
  /** Request/surface model reasoning. Omit → AI_REASONING env (defaults on). */
  reasoning?: boolean;
}

export function reasoningEnabled(flag?: boolean): boolean {
  if (typeof flag === "boolean") return flag;
  const env = process.env.AI_REASONING?.trim().toLowerCase();
  if (env === "false" || env === "0" || env === "off" || env === "no") return false;
  return true;
}

// Generic fallback persona. The support route always passes an explicit
// systemPrompt (buildSupportSystemPrompt), so this is rarely used.
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export interface LMModel {
  id: string;
  type?: string;
  state?: string;
  max_context_length?: number;
  loaded_context_length?: number;
  quantization?: string;
  arch?: string;
}
