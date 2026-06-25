import { kbForRole } from "./support-kb";

// The bot emits this token (optionally with a reason) when it cannot help and
// the thread must go to a human. Matched case-insensitively; reason optional.
export const ESCALATE_RE = /<<ESCALATE:?\s*([^>]*)>>/i;

export function parseEscalation(reply: string): {
  escalate: boolean;
  reason: string;
  clean: string;
} {
  const m = reply.match(ESCALATE_RE);
  if (!m) return { escalate: false, reason: "", clean: reply.trim() };
  const reason = (m[1] ?? "").trim() || "needs a human";
  const clean = reply.replace(ESCALATE_RE, "").trim();
  return { escalate: true, reason, clean };
}

const LOCALE_NAME: Record<string, string> = {
  en: "English",
  fr: "French",
  ar: "Arabic",
  ch: "Chinese",
};

export function buildSupportSystemPrompt(role: string, locale: string): string {
  const lang = LOCALE_NAME[locale] ?? "English";
  return `You are Blink Assistant, the in-app customer-support bot for Blink, a multi-service delivery super-app in Algeria (currency DZD, shown as "Da"). The person you are helping has the role "${role}".

Answer questions using ONLY the knowledge base below. Be concise, warm, and reply in ${lang}.

STRICT ESCALATION RULE — read carefully:
- If the question needs the user's personal account data (a specific order, trip, payment, wallet balance, refund status, delivery location) or anything NOT covered by the knowledge base, OR you are not confident, DO NOT guess and DO NOT invent details.
- In that case reply with EXACTLY this token and nothing else: <<ESCALATE: short reason>>
- A human support agent will then take over the conversation.

KNOWLEDGE BASE:
${kbForRole(role)}`;
}
