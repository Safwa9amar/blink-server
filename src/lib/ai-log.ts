// In-memory ring buffer of recent AI calls — every provider chat/stream the server
// makes (the support bot today, and anything added later), plus the "model reached
// its limit" case. Exposed to super admins via GET /ai-logs (the dashboard's
// "Blink Server → AI Log" tab). Nothing is persisted; it's a live tail of the last
// MAX entries — same approach as lib/log-buffer.ts. The cPanel/Passenger process is
// a singleton, so a module-level buffer captures the whole picture.
//
// Capture happens at the PROVIDER boundary via instrumentProvider() (applied in the
// buildProvider/getProvider factories), so any call site is logged automatically
// without instrumenting each one. Callers may pass `logContext` in ChatOptions to
// enrich a log with who/what triggered it (e.g. the support conversation + user).

import type {
  AIProvider,
  AIResponse,
  AiLogContext,
  ChatMessage,
  ChatOptions,
} from "./ai/types";

export type AiLogLevel = "info" | "warn" | "error";
// "reply" = a successful AI call. The rest are failures; rate_limit/quota are the
// "model reached its limit" cases (HTTP 429 / 402).
export type AiLogKind = "reply" | "rate_limit" | "quota" | "timeout" | "error";

export interface AiLogTokens {
  prompt?: number;
  completion?: number;
  total?: number;
}

export interface AiLogEntry {
  id: number; // monotonic — lets the dashboard poll incrementally (?since=)
  ts: string; // ISO timestamp
  level: AiLogLevel;
  kind: AiLogKind;
  source?: string | null; // call-site tag, e.g. "support-bot"
  conversationId?: string | null;
  userId?: string | null;
  userRole?: string | null;
  locale?: string | null;
  provider?: string | null;
  model?: string | null;
  statusCode?: number | null; // provider HTTP status (429 rate-limit / 402 out-of-credits)
  message?: string | null; // error message (failures only)
  userMessage?: string | null; // the user's prompt that triggered the call
  tokens?: AiLogTokens | null;
  latencyMs?: number | null;
}

export type LogAiEventInput = Omit<AiLogEntry, "id" | "ts">;

const MAX = 500;
const buffer: AiLogEntry[] = [];
let seq = 0;

/** Append one AI-call entry to the ring buffer. Best-effort — never throws. */
export function logAiEvent(input: LogAiEventInput): void {
  try {
    seq += 1;
    buffer.push({
      id: seq,
      ts: new Date().toISOString(),
      ...input,
      message: input.message ? input.message.slice(0, 2000) : (input.message ?? null),
      userMessage: input.userMessage
        ? input.userMessage.slice(0, 500)
        : (input.userMessage ?? null),
    });
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  } catch {
    /* never let logging break an AI call */
  }
}

/** Entries newer than `sinceId` (0 = everything buffered), capped at `limit`. */
export function getAiLogs(sinceId = 0, limit = 300): AiLogEntry[] {
  const fresh = sinceId > 0 ? buffer.filter((e) => e.id > sinceId) : buffer.slice();
  return fresh.slice(-limit);
}

export function clearAiLogs(): void {
  buffer.length = 0;
}

// ─── Error classification ────────────────────────────────────────────────────

export interface AiErrorInfo {
  kind: Exclude<AiLogKind, "reply">;
  level: AiLogLevel;
  statusCode: number | null;
  message: string;
}

/**
 * Classify a thrown AI-provider error into a log kind/level + HTTP status. The
 * "model reached its limit" cases are HTTP 429 (rate limit) and 402 (out of
 * credits / quota); everything else is a timeout or a generic error.
 */
export function classifyAiError(e: unknown): AiErrorInfo {
  const err = e as { status?: number; code?: string; message?: string } | undefined;
  const status = typeof err?.status === "number" ? err.status : null;
  const message = err?.message ?? String(e);
  const lower = message.toLowerCase();

  if (status === 429 || lower.includes("rate limit") || lower.includes("too many requests")) {
    return { kind: "rate_limit", level: "error", statusCode: status ?? 429, message };
  }
  if (
    status === 402 ||
    lower.includes("quota") ||
    lower.includes("insufficient") ||
    lower.includes("credit") ||
    lower.includes("billing")
  ) {
    return { kind: "quota", level: "error", statusCode: status ?? 402, message };
  }
  if (
    err?.code === "ETIMEDOUT" ||
    lower.includes("timeout") ||
    lower.includes("timed out") ||
    lower.includes("aborted")
  ) {
    return { kind: "timeout", level: "error", statusCode: status, message };
  }
  return { kind: "error", level: "error", statusCode: status, message };
}

/** True when an error is the "model reached its limit" case (rate / quota). */
export function isLimitError(info: AiErrorInfo): boolean {
  return info.kind === "rate_limit" || info.kind === "quota";
}

// ─── Provider instrumentation ────────────────────────────────────────────────

function lastUserContent(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return null;
}

function ctxFields(ctx?: AiLogContext) {
  return {
    source: ctx?.source ?? null,
    conversationId: ctx?.conversationId ?? null,
    userId: ctx?.userId ?? null,
    userRole: ctx?.userRole ?? null,
    locale: ctx?.locale ?? null,
  };
}

/**
 * Wrap a provider so every chat()/streamChat() call lands in the AI-log buffer —
 * a "reply" entry on success (with token usage + latency) or a classified failure
 * entry (rate_limit / quota / timeout / error) on throw. Pass-through for the rest
 * of the AIProvider surface. Applied in the buildProvider / getProvider factories.
 */
export function instrumentProvider(provider: AIProvider): AIProvider {
  const wrapped: AIProvider = {
    name: provider.name,
    listModels: () => provider.listModels(),

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<AIResponse> {
      const startedAt = Date.now();
      const userMessage = lastUserContent(messages);
      const base = { ...ctxFields(options?.logContext), provider: provider.name };
      try {
        const res = await provider.chat(messages, options);
        logAiEvent({
          ...base,
          level: "info",
          kind: "reply",
          model: res.model ?? options?.model ?? null,
          statusCode: 200,
          message: null,
          userMessage,
          tokens: res.usage
            ? {
                prompt: res.usage.promptTokens,
                completion: res.usage.completionTokens,
                total: res.usage.totalTokens,
              }
            : null,
          latencyMs: Date.now() - startedAt,
        });
        return res;
      } catch (e) {
        const info = classifyAiError(e);
        logAiEvent({
          ...base,
          level: info.level,
          kind: info.kind,
          model: options?.model ?? null,
          statusCode: info.statusCode,
          message: info.message,
          userMessage,
          tokens: null,
          latencyMs: Date.now() - startedAt,
        });
        throw e;
      }
    },

    async *streamChat(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
      const startedAt = Date.now();
      const userMessage = lastUserContent(messages);
      const base = { ...ctxFields(options?.logContext), provider: provider.name };
      try {
        let received = false;
        for await (const chunk of provider.streamChat(messages, options)) {
          received = true;
          yield chunk;
        }
        logAiEvent({
          ...base,
          level: "info",
          kind: "reply",
          model: options?.model ?? null,
          statusCode: 200,
          message: received ? null : "empty stream",
          userMessage,
          tokens: null,
          latencyMs: Date.now() - startedAt,
        });
      } catch (e) {
        const info = classifyAiError(e);
        logAiEvent({
          ...base,
          level: info.level,
          kind: info.kind,
          model: options?.model ?? null,
          statusCode: info.statusCode,
          message: info.message,
          userMessage,
          tokens: null,
          latencyMs: Date.now() - startedAt,
        });
        throw e;
      }
    },
  };

  // Forward the optional surface (used by the models/probe paths) unchanged.
  if (provider.getClient) wrapped.getClient = provider.getClient.bind(provider);
  if (provider.resolveModel) wrapped.resolveModel = provider.resolveModel.bind(provider);
  return wrapped;
}
