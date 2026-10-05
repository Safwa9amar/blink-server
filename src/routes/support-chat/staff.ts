import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  staffListSchema,
  SupportConversationListResponse,
  SupportOkResponse,
} from "../../validators/support-chat";
import { insertMessage, CONVERSATION_COLUMNS } from "../../lib/support-chat";
import { getConversation } from "./shared";

const app = router();

// GET /staff/conversations — inbox list (staff only).
const listRoute = createRoute({
  method: "get",
  path: "/staff/conversations",
  operationId: "listStaffSupportConversations",
  tags: ["admin-support-chat"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: { query: staffListSchema },
  responses: {
    200: json(SupportConversationListResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(listRoute, async (c) => {
  const { status, page, limit } = c.req.valid("query");
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS, { count: "exact" })
    .order("last_message_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ conversations: data ?? [], pagination: { page, limit, total: count ?? 0 } }, 200);
});

// POST /conversations/:id/assign — staff claims the thread.
const assignRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/assign",
  operationId: "assignSupportConversation",
  tags: ["admin-support-chat"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: { params: IdParam },
  responses: {
    200: json(SupportOkResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(assignRoute, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const { error } = await supabaseAdmin
    .from("support_conversations")
    .update({ status: "assigned", assigned_agent_id: user.id, unread_for_staff: 0 })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);

  const name = (user as any).full_name ?? "Support";
  await insertMessage(id, "system", user.id, "joined", { type: "assigned", agentName: name });
  return c.json({ ok: true }, 200);
});

// POST /conversations/:id/resolve — staff closes the thread.
const resolveRoute = createRoute({
  method: "post",
  path: "/conversations/{id}/resolve",
  operationId: "resolveSupportConversation",
  tags: ["admin-support-chat"],
  security: bearer,
  middleware: [requireStaff()] as const,
  request: { params: IdParam },
  responses: {
    200: json(SupportOkResponse),
    400: errorResponses[400],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(resolveRoute, async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const { error } = await supabaseAdmin
    .from("support_conversations")
    .update({ status: "resolved" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);

  await insertMessage(id, "system", user.id, "resolved", { type: "resolved" });
  return c.json({ ok: true }, 200);
});

export default app;
