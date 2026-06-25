import * as cheerio from "cheerio";
import { supabaseAdmin } from "./supabase";
import type { ChatMessage } from "./ai";
import { getAiConfig, buildProvider } from "./ai-settings";
import { buildSupportSystemPrompt, parseEscalation } from "./ai/support-prompt";
import { tokensForUser, sendPushToTokens } from "./push";
import type { SupportConversationRow, SupportMessageRow, SupportMessageSender } from "../db";

const PREVIEW_LEN = 120;

// The app user_role enum is lowercase ("rider"); support `target_roles` use the
// dashboard's capitalized labels ("Rider"). Map one to the other for targeting.
const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  rider: "Rider",
  merchant: "Merchant",
  agent: "Agent",
};

/** Build the bot's KB text from all PUBLISHED articles+FAQs for this role+locale. */
export async function fetchKbForRole(role: string, locale: string): Promise<string> {
  const label = ROLE_LABEL[role] ?? "Customer";
  const { data, error } = await supabaseAdmin
    .from("support_articles")
    .select("content_eng, content_fr, content_ar, target_roles, type")
    .eq("status", "published")
    .overlaps("target_roles", ["All", label])
    .order("sort", { ascending: true });
  if (error || !data?.length) return "";
  const pickKey = locale === "fr" ? "content_fr" : locale === "ar" ? "content_ar" : "content_eng";
  const entries = data
    .map((r: any) => {
      const c = r[pickKey] ?? r.content_eng;
      if (!c?.title) return null;
      const bodyText = cheerio
        .load(String(c.body ?? ""))
        .root()
        .text()
        .replace(/\s+/g, " ")
        .trim();
      return `Q: ${c.title}\nA: ${bodyText}`;
    })
    .filter(Boolean);
  return entries.join("\n\n");
}

// Columns the clients need (snake_case — supabase-js returns DB casing).
export const CONVERSATION_COLUMNS =
  "id, user_id, user_role, status, assigned_agent_id, subject, locale, last_message_at, last_message_preview, unread_for_staff, created_at, updated_at";
export const MESSAGE_COLUMNS = "id, conversation_id, sender, sender_id, body, meta, created_at";

/** Insert a message and bump the conversation's preview / timestamp. */
export async function insertMessage(
  conversationId: string,
  sender: SupportMessageSender,
  senderId: string | null,
  body: string,
  meta?: Record<string, unknown>
): Promise<SupportMessageRow | null> {
  const { data, error } = await supabaseAdmin
    .from("support_messages")
    .insert({
      conversation_id: conversationId,
      sender,
      sender_id: senderId,
      body,
      meta: meta ?? null,
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error || !data) {
    console.error("[support-chat] message insert failed", error?.message);
    return null;
  }
  await supabaseAdmin
    .from("support_conversations")
    .update({
      last_message_at: (data as any).created_at,
      last_message_preview: body.slice(0, PREVIEW_LEN),
    })
    .eq("id", conversationId);
  return data as unknown as SupportMessageRow;
}

/** Move a conversation into the human queue and add a system event line. */
export async function escalateConversation(
  conversation: SupportConversationRow,
  reason: string
): Promise<void> {
  await supabaseAdmin
    .from("support_conversations")
    .update({ status: "waiting" })
    .eq("id", conversation.id);
  await insertMessage(conversation.id, "system", null, "escalated", { type: "escalated", reason });
}

/** Map stored messages to the AI chat history (skip system event lines). */
export function toChatMessages(rows: Pick<SupportMessageRow, "sender" | "body">[]): ChatMessage[] {
  return rows
    .filter((r) => r.sender === "user" || r.sender === "bot" || r.sender === "agent")
    .map((r) => ({
      role: r.sender === "user" ? ("user" as const) : ("assistant" as const),
      content: r.body,
    }));
}

/**
 * Generate the bot's reply for a conversation in `bot` mode. `history` is the
 * full ordered message list INCLUDING the just-inserted user message. On an AI
 * error or an <<ESCALATE>> token, the conversation is escalated instead.
 */
export async function runBotTurn(
  conversation: SupportConversationRow,
  history: Pick<SupportMessageRow, "sender" | "body">[]
): Promise<void> {
  const cfg = await getAiConfig();
  if (!cfg.botEnabled) {
    await escalateConversation(conversation, "bot disabled");
    return;
  }
  const kbText = await fetchKbForRole(
    (conversation as any).user_role,
    conversation.locale
  );
  const base = buildSupportSystemPrompt(
    (conversation as any).user_role,
    conversation.locale,
    kbText,
    cfg.systemPrompt
  );
  const systemPrompt = base + (cfg.systemPromptExtra ? "\n\n" + cfg.systemPromptExtra : "");
  const messages = toChatMessages(history);
  let replyText: string;
  try {
    const res = await buildProvider(cfg).chat(messages, {
      systemPrompt,
      model: cfg.model ?? undefined,
      temperature: cfg.temperature,
      maxTokens: cfg.maxTokens,
      reasoning: cfg.reasoning,
    });
    replyText = res.content;
  } catch (e) {
    console.error("[support-chat] AI error", (e as Error).message);
    await escalateConversation(conversation, "assistant unavailable");
    return;
  }
  const { escalate, reason, clean } = parseEscalation(replyText);
  if (escalate || !clean) {
    await escalateConversation(conversation, escalate ? reason : "no answer");
    return;
  }
  await insertMessage(conversation.id, "bot", null, clean);
}

/** Best-effort push to the conversation owner when an agent replies. */
export async function pushAgentReplyToUser(
  conversation: SupportConversationRow,
  body: string
): Promise<void> {
  const tokens = await tokensForUser((conversation as any).user_id);
  await sendPushToTokens(tokens, {
    title: "Support replied",
    body: body.slice(0, PREVIEW_LEN),
    data: { type: "support", href: "/live-chat" },
  });
}
