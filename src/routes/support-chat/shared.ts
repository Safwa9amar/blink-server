import { supabaseAdmin } from "../../lib/supabase";
import { CONVERSATION_COLUMNS, MESSAGE_COLUMNS } from "../../lib/support-chat";
import type { SupportConversationRow } from "../../db";

export { CONVERSATION_COLUMNS, MESSAGE_COLUMNS };

/** Get the caller's single conversation, creating one (status `bot`) if none. */
export async function getOrCreateConversation(
  userId: string,
  userRole: string,
  locale: string
): Promise<{ conversation: SupportConversationRow | null; error: string | null }> {
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (selErr) return { conversation: null, error: selErr.message };
  if (existing) return { conversation: existing as unknown as SupportConversationRow, error: null };

  const { data: created, error: insErr } = await supabaseAdmin
    .from("support_conversations")
    .insert({ user_id: userId, user_role: userRole, locale, status: "bot" })
    .select(CONVERSATION_COLUMNS)
    .single();
  if (insErr || !created) return { conversation: null, error: insErr?.message ?? "create failed" };
  return { conversation: created as unknown as SupportConversationRow, error: null };
}

/** Load a conversation row by id (no scoping — caller authorizes). */
export async function getConversation(id: string): Promise<SupportConversationRow | null> {
  const { data } = await supabaseAdmin
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return (data as unknown as SupportConversationRow) ?? null;
}
