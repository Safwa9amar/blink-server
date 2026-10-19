import { supabaseAdmin } from "../../lib/supabase";
import { CONVERSATION_COLUMNS, MESSAGE_COLUMNS } from "../../lib/support-chat";
import type { SupportConversationRow } from "../../db";

export { CONVERSATION_COLUMNS, MESSAGE_COLUMNS };

/**
 * Get the caller's conversation for their active role, creating one (status
 * `bot`) if none. One thread per role: an account holding several roles keeps
 * a separate support history (and bot knowledge base) for each.
 */
export async function getOrCreateConversation(
  userId: string,
  userRole: string,
  locale: string
): Promise<{ conversation: SupportConversationRow | null; error: string | null }> {
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS)
    .eq("user_id", userId)
    .eq("user_role", userRole)
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

/** The caller owns this conversation: theirs, and of the role they're in now. */
export function ownsConversation(
  conversation: SupportConversationRow,
  user: { id: string; role: string }
): boolean {
  const c = conversation as any;
  return c.user_id === user.id && c.user_role === user.role;
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
