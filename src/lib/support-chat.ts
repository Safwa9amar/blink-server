import { supabaseAdmin } from "./supabase";
import { getProvider } from "./ai";
import type { ChatMessage } from "./ai";
import { buildSupportSystemPrompt, parseEscalation } from "./ai/support-prompt";
import { tokensForUser, sendPushToTokens } from "./push";
import type { SupportConversationRow, SupportMessageRow, SupportMessageSender } from "../db";

const PREVIEW_LEN = 120;

const ATTACHMENT_BUCKET = "support-attachments";

/** Upload a base64 image to storage; returns the public URL (or null on failure). */
export async function uploadAttachment(
  conversationId: string,
  base64: string,
  contentType: string
): Promise<string | null> {
  const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  // Strip a possible data: URL prefix.
  const cleaned = base64.includes(",") ? base64.split(",").pop()! : base64;
  const bytes = Buffer.from(cleaned, "base64");
  const path = `${conversationId}/${Date.now()}.${ext}`;
  const { error } = await supabaseAdmin.storage
    .from(ATTACHMENT_BUCKET)
    .upload(path, bytes, { contentType, upsert: false });
  if (error) {
    console.error("[support-chat] attachment upload failed", error.message);
    return null;
  }
  const { data } = supabaseAdmin.storage.from(ATTACHMENT_BUCKET).getPublicUrl(path);
  return data.publicUrl ?? null;
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
  const systemPrompt = buildSupportSystemPrompt(
    (conversation as any).user_role,
    conversation.locale
  );
  const messages = toChatMessages(history);
  let replyText: string;
  try {
    const res = await getProvider().chat(messages, {
      systemPrompt,
      temperature: 0.3,
      maxTokens: 600,
      reasoning: false,
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
