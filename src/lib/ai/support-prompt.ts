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

export function buildSupportSystemPrompt(role: string, locale: string, kbText: string): string {
  const lang = LOCALE_NAME[locale] ?? "English";
  return `You are Blink Assistant, the in-app customer-support bot for Blink, a multi-service delivery super-app in Algeria (currency DZD, shown as "Da"). The person you are helping has the role "${role}".

Be concise, warm, and reply in ${lang}.

HOW TO ANSWER — read carefully:
- For any GENERAL or how-to question, ANSWER it from the knowledge base below — e.g. "how do I track an order", "how do payouts work", "how do I reset my password", "what is Blink", "how do I create a rider account". Answer these helpfully even if they phrase it as "my order" / "my account" in a general way. Do NOT escalate questions the knowledge base covers.
- ONLY escalate when the user needs you to look up or change their SPECIFIC private account data that is NOT in the knowledge base — e.g. "where is my order #1234 right now", "why was I charged 500 Da", "cancel my order", "I still haven't received my refund". You genuinely cannot answer those without their private data.
- To escalate (and ONLY then), reply with EXACTLY this token and nothing else: <<ESCALATE: short reason>>. A human agent then takes over.
- Never invent specifics (order numbers, amounts, ETAs). If the knowledge base has a general answer, give it rather than escalating.

KNOWLEDGE BASE:
${kbText || "(no articles available)"}`;
}
