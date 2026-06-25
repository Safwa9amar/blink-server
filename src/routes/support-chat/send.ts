import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { sendMessageSchema } from "../../validators/support-chat";
import {
  insertMessage,
  runBotTurn,
  pushAgentReplyToUser,
} from "../../lib/support-chat";
import { getConversation } from "./shared";

const app = new Hono<AuthEnv>();

// POST /conversations/:id/messages — send a message.
// Sender derived from the caller: owner → "user"; staff → "agent".
app.post("/conversations/:id/messages", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { body } = sendMessageSchema.parse(await c.req.json());

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const convUserId = (conversation as any).user_id as string;
  const isOwner = convUserId === user.id;
  const isStaff = !!(user as any).staff_role;
  if (!isOwner && !isStaff) return c.json({ error: "Access denied" }, 403);

  const sender = isOwner ? "user" : "agent";
  const message = await insertMessage(id, sender, user.id, body);
  if (!message) return c.json({ error: "Failed to send" }, 400);

  if (isOwner && !(conversation as any).subject) {
    await supabaseAdmin
      .from("support_conversations")
      .update({ subject: body.slice(0, 120) })
      .eq("id", id);
  }

  if (sender === "agent") {
    await pushAgentReplyToUser(conversation, body);
    return c.json({ message }, 201);
  }

  // A user message: a resolved conversation reopens in `bot` mode; a bot-handled
  // conversation gets a bot turn. (When `waiting`/`assigned`, a human handles it.)
  if (conversation.status === "resolved") {
    await supabaseAdmin.from("support_conversations").update({ status: "bot" }).eq("id", id);
  }
  if (conversation.status === "bot" || conversation.status === "resolved") {
    const { data: history } = await supabaseAdmin
      .from("support_messages")
      .select("sender, body")
      .eq("conversation_id", id)
      .order("created_at", { ascending: true });
    await runBotTurn(
      { ...conversation, status: "bot" },
      (history ?? [{ sender: "user", body }]) as { sender: any; body: string }[]
    );
  }

  return c.json({ message }, 201);
});

export default app;
