import { env } from "../../config/env";
import type { AIProvider, ChatMessage, ChatOptions } from "./types";
import { OpenRouterProvider } from "./openrouter";
import { OllamaProvider } from "./ollama";
import { LMStudioProvider } from "./lmstudio";

export type { AIProvider, ChatMessage, ChatOptions, AIResponse, LMModel } from "./types";
export { DEFAULT_SYSTEM_PROMPT, reasoningEnabled } from "./types";
export { OpenRouterProvider } from "./openrouter";
export { OllamaProvider } from "./ollama";
export { LMStudioProvider } from "./lmstudio";

export type ProviderName = "openrouter" | "ollama" | "lmstudio";

export function getDefaultProvider(): ProviderName {
  return env.DEFAULT_AI_PROVIDER;
}

const providers = new Map<ProviderName, AIProvider>();

export function getProvider(name: ProviderName = getDefaultProvider()): AIProvider {
  let p = providers.get(name);
  if (!p) {
    switch (name) {
      case "openrouter":
        p = new OpenRouterProvider();
        break;
      case "ollama":
        p = new OllamaProvider();
        break;
      case "lmstudio":
        p = new LMStudioProvider();
        break;
      default:
        throw new Error(`Unknown AI provider: ${name}`);
    }
    providers.set(name, p);
  }
  return p;
}

// Convenience one-shot chat: prepend history, append the new user message.
export async function chat(
  userMessage: string,
  history: ChatMessage[] = [],
  options?: ChatOptions & { provider?: ProviderName }
) {
  const provider = getProvider(options?.provider);
  const messages: ChatMessage[] = [...history, { role: "user", content: userMessage }];
  return provider.chat(messages, options);
}
