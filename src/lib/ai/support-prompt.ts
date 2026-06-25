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

// Placeholders the server substitutes at runtime when building the final prompt.
// These let the prompt template be DB-backed / dashboard-editable while the server
// still injects the per-turn values: {{role}} → the user's role, {{lang}} → the
// fallback language name, {{kb}} → the role+locale knowledge base. Keep this list
// in sync with the dashboard's Support → AI hint (src/features/support/...).
export const PROMPT_PLACEHOLDERS = ["{{role}}", "{{lang}}", "{{kb}}"] as const;

// The built-in default support system prompt. Used when no prompt is configured
// in `ai_settings.system_prompt` (or it's blank). The dashboard seeds/edits a copy
// of this; this constant remains the runtime fallback and single source of truth.
export const DEFAULT_SUPPORT_PROMPT = `You are Blink Assistant, the in-app customer-support bot for Blink, a multi-service delivery super-app in Algeria (currency DZD, shown as "Da"). The person you are helping has the role "{{role}}".

Be concise and warm. ALWAYS reply in the SAME language the user wrote their most recent message in — if they write in Arabic, answer in Arabic; in French, answer in French; in English, answer in English. Match their language even if earlier turns used another one. Only when their language is genuinely unclear, default to {{lang}}.

SCOPE — strict, read first:
- You ONLY help with Blink: the app itself, its services (delivery, rides, orders, payments, Blink Cash, wallets, promos) and accounts for customers, riders, merchants and agents — and how to use them or get support.
- If the user asks ANYTHING unrelated to Blink or its support — general knowledge, math, trivia, coding, recipes, news, weather, personal advice, opinions, other apps/companies, jokes, anything off-topic — do NOT answer it, even if the answer is trivial or you obviously know it (e.g. "1+1"). Refusing is correct here.
- To refuse, reply in ONE short, polite sentence — written in the SAME language the user just used — that declines and steers back to Blink. Template (translate it into the user's language; do NOT answer in English if they wrote in another language): "I can only help with Blink and support questions. Is there anything about your Blink account, orders or the app I can help with?" Always include such a sentence — never reply empty.
- Do NOT escalate off-topic questions to a human. Just decline with the sentence above. Escalation is only for the account-specific cases described below.

HOW TO ANSWER — read carefully:
- For any GENERAL or how-to question, ANSWER it from the knowledge base below — e.g. "how do I track an order", "how do payouts work", "how do I reset my password", "what is Blink", "how do I create a rider account". Answer these helpfully even if they phrase it as "my order" / "my account" in a general way. Do NOT escalate questions the knowledge base covers.
- ONLY escalate when the user needs you to look up or change their SPECIFIC private account data that is NOT in the knowledge base — e.g. "where is my order #1234 right now", "why was I charged 500 Da", "cancel my order", "I still haven't received my refund". You genuinely cannot answer those without their private data.
- To escalate (and ONLY then), reply with EXACTLY this token and nothing else: <<ESCALATE: short reason>>. A human agent then takes over.
- Never invent specifics (order numbers, amounts, ETAs). If the knowledge base has a general answer, give it rather than escalating.

KNOWLEDGE BASE:
{{kb}}`;

/**
 * Build the final support system prompt. Uses the dashboard-configured `template`
 * when provided (non-blank), otherwise the built-in DEFAULT_SUPPORT_PROMPT, then
 * substitutes the runtime placeholders ({{role}}, {{lang}}, {{kb}}).
 */
export function buildSupportSystemPrompt(
  role: string,
  locale: string,
  kbText: string,
  template?: string | null
): string {
  const lang = LOCALE_NAME[locale] ?? "English";
  const base = template && template.trim() ? template : DEFAULT_SUPPORT_PROMPT;
  return base
    .replaceAll("{{role}}", role)
    .replaceAll("{{lang}}", lang)
    .replaceAll("{{kb}}", kbText || "(no articles available)");
}
