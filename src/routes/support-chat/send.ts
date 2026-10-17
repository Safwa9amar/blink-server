import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { sendMessageSchema, SupportMessageResponse } from "../../validators/support-chat";
import {
  insertMessage,
  runBotTurn,
  pushAgentReplyToUser,
  escalateConversation,
} from "../../lib/support-chat";
import { getConversation, ownsConversation } from "./shared";

const app = router();

// POST /conversations/:id/messages — send a message.
// Sender derived from the caller: owner → "user"; staff → "agent".
const route = createRoute({
  method: "post",
  path: "/conversations/{id}/messages",
  operationId: "sendSupportMessage",
  tags: ["support-chat"],
  security: bearer,
  request: { params: IdParam, body: { ...json(sendMessageSchema), required: true } },
  responses: {
    201: json(SupportMessageResponse, "Created"),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { body, attachmentUrl } = c.req.valid("json");

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const isOwner = ownsConversation(conversation, user);
  const isStaff = !!user.staff_role;
  if (!isOwner && !isStaff) return c.json({ error: "Access denied" }, 403);

  const text = (body ?? "").trim();
  const meta = attachmentUrl ? { attachmentUrl, attachmentType: "image" } : undefined;

  const sender = isOwner ? "user" : "agent";
  const message = await insertMessage(id, sender, user.id, text || "📷 Photo", meta);
  if (!message) return c.json({ error: "Failed to send" }, 400);

  if (isOwner && !(conversation as any).subject) {
    await supabaseAdmin
      .from("support_conversations")
      .update({ subject: (text || "📷 Photo").slice(0, 120) })
      .eq("id", id);
  }

  if (sender === "agent") {
    await pushAgentReplyToUser(conversation, text || "📷 Photo");
    return c.json({ message }, 201);
  }

  // An image-only owner message can't be handled by the text model — escalate.
  if (attachmentUrl && !text) {
    await escalateConversation(conversation, "sent a photo");
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
      (history ?? [{ sender: "user", body: text }]) as { sender: any; body: string }[]
    );
  }

  return c.json({ message }, 201);
});

export default app;
