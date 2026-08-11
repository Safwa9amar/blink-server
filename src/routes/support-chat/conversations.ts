import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { listMessagesSchema } from "../../validators/support-chat";
import { MESSAGE_COLUMNS, getOrCreateConversation, getConversation } from "./shared";

const app = new Hono<AuthEnv>();

// POST /conversations — get-or-create the caller's conversation + recent messages.
app.post("/conversations", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => ({}));
  const useLocale = typeof body?.locale === "string" ? body.locale : "en";

  const { conversation, error } = await getOrCreateConversation(user.id, user.role, useLocale);
  if (error || !conversation) return c.json({ error: error ?? "failed" }, 400);

  // Newest 50, then reversed to chronological order — fetching ascending+limit
  // would return the OLDEST 50 and silently drop recent messages once a thread
  // grows past 50, making the app look like it "lost" the conversation.
  const { data: messages } = await supabaseAdmin
    .from("support_messages")
    .select(MESSAGE_COLUMNS)
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(50);

  return c.json({ conversation, messages: (messages ?? []).reverse() });
});

// GET /conversations/:id/messages — paginated history (owner or staff).
app.get("/conversations/:id/messages", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { page, limit } = listMessagesSchema.parse(c.req.query());

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  const isStaff = !!user.staff_role;
  if ((conversation as any).user_id !== user.id && !isStaff) {
    return c.json({ error: "Access denied" }, 403);
  }

  const offset = (page - 1) * limit;
  const { data, error, count } = await supabaseAdmin
    .from("support_messages")
    .select(MESSAGE_COLUMNS, { count: "exact" })
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ messages: data ?? [], pagination: { page, limit, total: count ?? 0 } });
});

export default app;
