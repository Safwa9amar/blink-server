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

// ─── AI metrics (Blink Server → AI Insights, Phase 5) ────────────────────────
// Rollups over the buffered AI calls (the last MAX entries). Approximate public list
// prices, USD per 1M tokens (input/output) — ESTIMATES only; providers change pricing
// and local models are free, so unknown/local models contribute 0 cost.
// First match wins, so list more specific patterns before broader ones. Includes
// google/gemini-2.5-flash — the default production model (src/lib/ai/openrouter.ts).
const AI_PRICES: { match: RegExp; in: number; out: number }[] = [
  { match: /opus/i, in: 15, out: 75 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 0.8, out: 4 },
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /gpt-4o/i, in: 2.5, out: 10 },
  { match: /gpt-4/i, in: 30, out: 60 },
  { match: /gpt-3\.5/i, in: 0.5, out: 1.5 },
  { match: /gemini[-.]?2\.5[-.]?flash/i, in: 0.3, out: 2.5 },
  { match: /gemini[-.]?1\.5[-.]?flash/i, in: 0.075, out: 0.3 },
  { match: /gemini/i, in: 1.25, out: 5 }, // other Gemini (Pro-tier) — rough estimate
  { match: /deepseek/i, in: 0.14, out: 0.28 },
  { match: /llama|mistral|qwen|gemma|mixtral/i, in: 0.2, out: 0.2 },
];
function priceFor(model: string): { in: number; out: number } {
  for (const p of AI_PRICES) if (p.match.test(model)) return { in: p.in, out: p.out };
  return { in: 0, out: 0 };
}

export interface AiModelStat {
  model: string;
  provider: string | null;
  calls: number;
  limitHits: number;
  errPct: number;
  avgMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  status: "ok" | "degraded";
}

export interface AiMetricsSnapshot {
  totalCalls: number;
  replies: number;
  failures: number;
  limitHits: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estCostUsd: number;
  avgLatencyMs: number;
  models: AiModelStat[]; // sorted by calls desc
}

interface ModelAcc {
  provider: string | null;
  calls: number;
  errors: number;
  limitHits: number;
  latMs: number;
  latN: number;
  prompt: number;
  completion: number;
}

export function getAiMetrics(): AiMetricsSnapshot {
  let replies = 0;
  let failures = 0;
  let limitHits = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let latMs = 0;
  let latN = 0;
  const byModel = new Map<string, ModelAcc>();

  for (const e of buffer) {
    const isReply = e.kind === "reply";
    const isLimit = e.kind === "rate_limit" || e.kind === "quota";
    if (isReply) replies++;
    else failures++;
    if (isLimit) limitHits++;

    const p = e.tokens?.prompt ?? 0;
    const comp = e.tokens?.completion ?? 0;
    promptTokens += p;
    completionTokens += comp;
    // Latency over successful replies only — failures/timeouts are the slow tail and
    // would inflate what reads as "avg response time".
    if (isReply && typeof e.latencyMs === "number") {
      latMs += e.latencyMs;
      latN++;
    }

    const model = e.model ?? "unknown";
    let acc = byModel.get(model);
    if (!acc) {
      acc = {
        provider: e.provider ?? null,
        calls: 0,
        errors: 0,
        limitHits: 0,
        latMs: 0,
        latN: 0,
        prompt: 0,
        completion: 0,
      };
      byModel.set(model, acc);
    }
    acc.calls++;
    if (!isReply) acc.errors++;
    if (isLimit) acc.limitHits++;
    acc.prompt += p;
    acc.completion += comp;
    if (isReply && typeof e.latencyMs === "number") {
      acc.latMs += e.latencyMs;
      acc.latN++;
    }
  }

  let rawCostTotal = 0;
  const models: AiModelStat[] = [...byModel.entries()]
    .map(([model, a]): AiModelStat => {
      const price = priceFor(model);
      const rawCost = (a.prompt / 1e6) * price.in + (a.completion / 1e6) * price.out;
      rawCostTotal += rawCost; // sum raw; round the total once below (no compounded rounding)
      const errPct = a.calls ? Math.round((a.errors / a.calls) * 1000) / 10 : 0;
      return {
        model,
        provider: a.provider,
        calls: a.calls,
        limitHits: a.limitHits,
        errPct,
        avgMs: a.latN ? Math.round(a.latMs / a.latN) : 0,
        promptTokens: a.prompt,
        completionTokens: a.completion,
        costUsd: Math.round(rawCost * 100) / 100,
        status: a.limitHits > 0 || errPct >= 20 ? "degraded" : "ok",
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const estCostUsd = Math.round(rawCostTotal * 100) / 100;

  return {
    totalCalls: replies + failures,
    replies,
    failures,
    limitHits,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estCostUsd,
    avgLatencyMs: latN ? Math.round(latMs / latN) : 0,
    models,
  };
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
