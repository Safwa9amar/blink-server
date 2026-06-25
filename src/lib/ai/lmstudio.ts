import OpenAI from "openai";
import type { AIProvider, ChatMessage, ChatOptions, AIResponse, LMModel } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./types";

export class LMStudioProvider implements AIProvider {
  name = "lmstudio";
  private client: OpenAI;
  /** Bare host root (no trailing `/v1`) — LM Studio's native API lives here. */
  private baseUrl: string;
  /** Model id pinned via LMSTUDIO_MODEL; empty = auto-pick whatever is loaded. */
  private pinnedModel: string;

  constructor(baseUrl?: string) {
    const raw = (baseUrl || process.env.LMSTUDIO_URL || "http://localhost:1234").trim();
    // Tolerate a host given with or without `/v1` (a common footgun): store the bare
    // root for the native endpoints, and hand `${root}/v1` to the OpenAI client.
    this.baseUrl = raw.replace(/\/+$/, "").replace(/\/v1$/, "");
    // Pin a model so the app doesn't depend on whatever happens to be loaded in the
    // LM Studio UI (e.g. a slow reasoning model that times out interactive chat).
    this.pinnedModel = process.env.LMSTUDIO_MODEL?.trim() || "";
    this.client = new OpenAI({
      baseURL: this.baseUrl + "/v1",
      apiKey: "lm-studio",
      // Bound a stuck generation (or an unreachable host) instead of the SDK's
      // 10-minute default — so failures surface fast and clean.
      timeout: Number(process.env.AI_TIMEOUT_MS) || 120_000,
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse> {
    const model = options?.model || (await this.getDefaultModel());

    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: "system", content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT }, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      // LM Studio extension: auto-unload a JIT-loaded model after `ttl` idle seconds.
      ...(options?.ttl && options.ttl > 0 ? { ttl: options.ttl } : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

    // Reasoning ("thinking") models may leave `content` empty and put their text in
    // `reasoning_content` — fall back to it so the answer isn't dropped.
    const message = response.choices[0]?.message as
      | { content?: string | null; reasoning_content?: string | null }
      | undefined;
    const content = (message?.content || message?.reasoning_content || "").trim();
    if (!content) {
      throw new Error(
        "The model returned no text. If it's a reasoning model (e.g. Qwen3 'thinking'), pick an instruct model instead."
      );
    }

    return {
      content,
      model: response.model || model,
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
    const model = options?.model || (await this.getDefaultModel());

    const stream = await this.client.chat.completions.create({
      model,
      messages: [{ role: "system", content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT }, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stream: true,
      ...(options?.ttl && options.ttl > 0 ? { ttl: options.ttl } : {}),
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta as
        | { content?: string | null; reasoning_content?: string | null }
        | undefined;
      // Prefer the visible answer; reasoning models without a content channel fall
      // back to reasoning_content so streaming isn't silent.
      const content = delta?.content || delta?.reasoning_content;
      if (content) yield content;
    }
  }

  /** Ids only — satisfies the AIProvider interface and the provider health check. */
  async listModels(): Promise<string[]> {
    const models = await this.listModelsDetailed();
    return models.map((m) => m.id).filter(Boolean);
  }

  /**
   * Rich model list with load state, context length and type. Uses LM Studio's
   * native `GET /api/v0/models`, falling back to the OpenAI-compatible `/v1/models`
   * (ids only) if the native API is disabled.
   */
  async listModelsDetailed(): Promise<LMModel[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v0/models`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const json = (await res.json()) as { data?: LMModel[] };
        return json.data ?? [];
      }
    } catch {
      /* native API off or unreachable — fall through to the OpenAI list */
    }
    try {
      const response = await this.client.models.list();
      return response.data.map((m) => ({ id: m.id }));
    } catch {
      return [];
    }
  }

  /**
   * Loads (preloads) a model into memory via LM Studio's native API, optionally
   * pinning a context length. The LM Studio analog of Ollama's `pullModel`.
   */
  async loadModel(model: string, contextLength?: number): Promise<{ success: boolean; message: string }> {
    try {
      const body: Record<string, unknown> = { model };
      if (contextLength && contextLength > 0) body.context_length = contextLength;
      const res = await fetch(`${this.baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return { success: true, message: `Model ${model} loaded` };
      return { success: false, message: (await this.errorDetail(res)) || `Failed to load ${model} (${res.status})` };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  /**
   * Unloads (stops) a loaded model, freeing its memory. LM Studio identifies the
   * instance to unload by `instance_id` (which equals the model id when it was
   * loaded once).
   */
  async unloadModel(instanceId: string): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId }),
      });
      if (res.ok) return { success: true, message: `Model ${instanceId} unloaded` };
      return {
        success: false,
        message: (await this.errorDetail(res)) || `Failed to unload ${instanceId} (${res.status})`,
      };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl + "/v1/models", { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Pulls a `{ error }` message out of a failed native response, if present. */
  private async errorDetail(res: Response): Promise<string | undefined> {
    const json = (await res.json().catch(() => null)) as { error?: { message?: string } | string } | null;
    if (!json) return undefined;
    return typeof json.error === "string" ? json.error : json.error?.message;
  }

  getClient(): OpenAI {
    return this.client;
  }

  /** Public model resolver for the tool-calling loop (mirrors getDefaultModel). */
  async resolveModel(model?: string): Promise<string> {
    return model || (await this.getDefaultModel());
  }

  private async getDefaultModel(): Promise<string> {
    // A pinned model wins — and saves a round trip to list models.
    if (this.pinnedModel) return this.pinnedModel;
    const models = await this.listModelsDetailed();
    // Prefer a model already loaded in memory — avoids a slow just-in-time load.
    const loaded = models.find((m) => m.state === "loaded");
    return loaded?.id || models[0]?.id || "default";
  }
}
