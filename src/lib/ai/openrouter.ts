import OpenAI from "openai";
import type { AIProvider, ChatMessage, ChatOptions, AIResponse } from "./types";
import { DEFAULT_SYSTEM_PROMPT, reasoningEnabled, embedBatched, type EmbedOptions, type EmbedResult } from "./types";

// OpenRouter extension: explicitly disable reasoning when it's turned off, so
// non-reasoning models (e.g. Gemma) aren't asked to think. Empty when on.
function reasoningParam(options?: ChatOptions): Record<string, unknown> {
  return reasoningEnabled(options?.reasoning) ? {} : { reasoning: { enabled: false } };
}

// Fast, cheap default. Free 550B models on OpenRouter are queued and slow —
// this is the main lever for response latency. Override with OPENROUTER_MODEL.
const DEFAULT_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash";

// Embedding default, picked by an eval on the real support FAQs (question → its
// answer, en/fr/ar): gemini-embedding-001 hit@1 91/90/88%, vs 89/82/68% for
// openai/text-embedding-3-small, which is weak on Arabic. Override with
// OPENROUTER_EMBED_MODEL or ai_settings.embedding_model.
export const DEFAULT_EMBED_MODEL =
  process.env.OPENROUTER_EMBED_MODEL || "google/gemini-embedding-001";

export class OpenRouterProvider implements AIProvider {
  name = "openrouter";
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: apiKey || process.env.OPENROUTER_API_KEY!,
      defaultHeaders: {
        "HTTP-Referer": "https://blink.dz",
        "X-Title": "blink",
      },
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse> {
    const model = options?.model || DEFAULT_MODEL;

    const systemMessage: ChatMessage = {
      role: "system",
      content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    };

    const response = await this.client.chat.completions.create({
      model,
      messages: [systemMessage, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      ...reasoningParam(options),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    const choice = response.choices[0];
    // Reasoning models may leave `content` empty and answer in their reasoning
    // field (`reasoning` on OpenRouter, `reasoning_content` elsewhere).
    const msg = choice?.message as
      | { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
      | undefined;

    return {
      content: msg?.content || msg?.reasoning || msg?.reasoning_content || "I couldn't generate a response. Please try again.",
      model,
      provider: this.name,
      usage: response.usage
        ? {
            promptTokens: response.usage.prompt_tokens,
            completionTokens: response.usage.completion_tokens,
            totalTokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    const model = options?.model || DEFAULT_MODEL;

    const systemMessage: ChatMessage = {
      role: "system",
      content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    };

    const stream = await this.client.chat.completions.create({
      model,
      messages: [systemMessage, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stream: true,
      ...reasoningParam(options),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
        | undefined;
      // Prefer the visible answer; fall back to reasoning so the stream is never
      // silent for a reasoning-only model.
      const content = delta?.content || delta?.reasoning || delta?.reasoning_content;
      if (content) yield content;
    }
  }

  getClient(): OpenAI {
    return this.client;
  }

  async resolveModel(model?: string): Promise<string> {
    return model || DEFAULT_MODEL;
  }

  async embed(input: string[], opts?: EmbedOptions): Promise<EmbedResult> {
    const model = opts?.model || DEFAULT_EMBED_MODEL;
    return { embeddings: await embedBatched(this.client, model, input, opts), model };
  }

  async listEmbeddingModels(): Promise<string[]> {
    const fallback = [
      DEFAULT_EMBED_MODEL,
      "qwen/qwen3-embedding-4b",
      "openai/text-embedding-3-small",
      "openai/text-embedding-3-large",
      "baai/bge-m3",
      "intfloat/multilingual-e5-large",
    ];
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models?output_modalities=embeddings", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return fallback;
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort();
      return ids.length ? ids : fallback;
    } catch {
      return fallback;
    }
  }

  async listModels(): Promise<string[]> {
    // Live list of REAL model ids from OpenRouter's public models API — only ids
    // the API actually accepts (the old hardcoded list had invalid ids).
    const fallback = ["google/gemini-2.5-flash", "openai/gpt-4o-mini"];
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return fallback;
      const json = (await res.json()) as { data?: { id?: string }[] };
      const ids = (json.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
        .sort();
      return ids.length ? ids : fallback;
    } catch {
      return fallback;
    }
  }
}
