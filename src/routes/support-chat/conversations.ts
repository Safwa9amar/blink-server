import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  listMessagesSchema,
  openConversationSchema,
  rateConversationSchema,
  SupportOkResponse,
  SupportConversationResponse,
  SupportMessageListResponse,
} from "../../validators/support-chat";
import { insertMessage } from "../../lib/support-chat";
import { MESSAGE_COLUMNS, getOrCreateConversation, getConversation, ownsConversation } from "./shared";

const app = router();

// POST /conversations — get-or-create the caller's conversation + recent messages.
const openRoute = createRoute({
  method: "post",
  path: "/conversations",
  operationId: "openSupportConversation",
  tags: ["support-chat"],
  security: bearer,
  request: { body: { ...json(openConversationSchema), required: false } },
  responses: { 200: json(SupportConversationResponse), 400: errorResponses[400] },
});

app.openapi(openRoute, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
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

  return c.json({ conversation, messages: (messages ?? []).reverse() }, 200);
});

// GET /conversations/:id/messages — paginated history (owner or staff).
const messagesRoute = createRoute({
  method: "get",
  path: "/conversations/{id}/messages",
  operationId: "listSupportMessages",
  tags: ["support-chat"],
  security: bearer,
  request: { params: IdParam, query: listMessagesSchema },
  responses: {
    200: json(SupportMessageListResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(messagesRoute, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { page, limit } = c.req.valid("query");

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  const isStaff = !!user.staff_role;
  if (!ownsConversation(conversation, user) && !isStaff) {
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

  return c.json({ messages: data ?? [], pagination: { page, limit, total: count ?? 0 } }, 200);
});

// POST /conversations/:id/rate — owner rates a resolved conversation (CSAT).
// Rating again overwrites the earlier one.
const rateRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/rate",
  operationId: "rateSupportConversation",
  tags: ["support-chat"],
  security: bearer,
  request: { params: IdParam, body: json(rateConversationSchema) },
  responses: {
    200: json(SupportOkResponse),
    400: errorResponses[400],
    404: errorResponses[404],
    409: errorResponses[409],
  },
});

app.openapi(rateRoute, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const { rating, comment } = c.req.valid("json");

  const conversation = await getConversation(id);
  // Not-owner is reported as 404 so conversation ids can't be probed.
  if (!conversation || !ownsConversation(conversation, user)) {
    return c.json({ error: "Conversation not found" }, 404);
  }
  if (conversation.status !== "resolved") {
    return c.json({ error: "Conversation is not resolved", code: "not_resolved" }, 409);
  }

  const { error } = await supabaseAdmin
    .from("support_conversations")
    .update({
      csat_rating: rating,
      csat_comment: comment?.trim() ? comment.trim() : null,
      csat_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);

  await insertMessage(id, "system", user.id, "rated", { type: "rated", rating });
  return c.json({ ok: true }, 200);
});

export default app;
