import OpenAI from "openai";
import type { AIProvider, ChatMessage, ChatOptions, AIResponse } from "./types";
import { DEFAULT_SYSTEM_PROMPT } from "./types";

export class OllamaProvider implements AIProvider {
  name = "ollama";
  private client: OpenAI;
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.OLLAMA_URL || "http://localhost:11434";
    this.client = new OpenAI({
      baseURL: this.baseUrl + "/v1",
      apiKey: "ollama",
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse> {
    const model = options?.model || await this.getDefaultModel();

    const response = await this.client.chat.completions.create({
      model,
      messages: [{ role: "system", content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT }, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
    });

    return {
      content: response.choices[0]?.message?.content || "",
      model,
      provider: this.name,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async *streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    const model = options?.model || await this.getDefaultModel();

    const stream = await this.client.chat.completions.create({
      model,
      messages: [{ role: "system", content: options?.systemPrompt || DEFAULT_SYSTEM_PROMPT }, ...messages],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(this.baseUrl + "/api/tags");
      const data = await response.json() as any;
      return (data.models || []).map((m: any) => m.name);
    } catch {
      return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl + "/api/version", { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async pullModel(modelName: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(this.baseUrl + "/api/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName, stream: false }),
      });
      if (response.ok) return { success: true, message: `Model ${modelName} pulled successfully` };
      return { success: false, message: `Failed to pull ${modelName}` };
    } catch (e: any) {
      return { success: false, message: e.message };
    }
  }

  async getModelInfo(modelName: string): Promise<any> {
    try {
      const response = await fetch(this.baseUrl + "/api/show", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      });
      return await response.json();
    } catch {
      return null;
    }
  }

  getClient(): OpenAI {
    return this.client;
  }

  /** Public model resolver for the tool-calling loop (mirrors getDefaultModel). */
  async resolveModel(model?: string): Promise<string> {
    return model || (await this.getDefaultModel());
  }

  private async getDefaultModel(): Promise<string> {
    const models = await this.listModels();
    // Prefer larger models first
    const preferred = ["llama3.2", "llama3.1", "qwen2.5", "mistral", "gemma2"];
    for (const p of preferred) {
      const found = models.find((m) => m.startsWith(p));
      if (found) return found;
    }
    return models[0] || "llama3.2";
  }
}
