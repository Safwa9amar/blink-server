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
  /** Embed a batch of strings (RAG). Optional — not every provider/wrapper has it. */
  embed?(input: string[], opts?: EmbedOptions): Promise<EmbedResult>;
  /** Embedding-capable model ids for this provider. */
  listEmbeddingModels?(): Promise<string[]>;
}

export interface EmbedOptions {
  model?: string;
  /** Per-request timeout. Default AI_EMBED_TIMEOUT_MS or 60s (indexing). */
  timeoutMs?: number;
  /** SDK retries. Default 1. */
  maxRetries?: number;
}

export interface EmbedResult {
  embeddings: number[][];
  model: string;
}

/** Max inputs per embeddings request. */
export const EMBED_BATCH = 64;

/** Shared batching over an OpenAI-compatible embeddings endpoint. */
export async function embedBatched(
  client: OpenAI,
  model: string,
  input: string[],
  opts: Pick<EmbedOptions, "timeoutMs" | "maxRetries"> = {}
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < input.length; i += EMBED_BATCH) {
    const slice = input.slice(i, i + EMBED_BATCH);
    const res = await client.embeddings.create(
      { model, input: slice, encoding_format: "float" },
      {
        timeout: opts.timeoutMs ?? (Number(process.env.AI_EMBED_TIMEOUT_MS) || 60_000),
        maxRetries: opts.maxRetries ?? 1,
      }
    );
    const sorted = [...res.data].sort((a, b) => a.index - b.index);
    if (sorted.length !== slice.length) throw new Error("embeddings: unexpected result count");
    for (const d of sorted) out.push(d.embedding as number[]);
  }
  return out;
}

// Optional caller context attached to a chat() call, surfaced in the AI-log
// buffer so an entry shows who/what triggered the call. The providers themselves
// ignore it — only instrumentProvider() in ../ai-log reads it.
export interface AiLogContext {
  /** Call-site tag, e.g. "support-bot". */
  source?: string | null;
  conversationId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  locale?: string | null;
  /** Support-bot KB path that ran: "rag-hybrid" | "rag-keyword" | "full-kb" | "full-kb-fallback". */
  kbMode?: string | null;
  /** Number of KB chunks injected (RAG) or articles (full KB). */
  kbChunks?: number | null;
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
  /** Caller context for the AI-log buffer (ignored by providers). */
  logContext?: AiLogContext;
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
