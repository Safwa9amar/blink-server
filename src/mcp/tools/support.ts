import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ROLES = ["support_admin", "ops_admin"] as const;
const CONV_COLS =
  "id, user_id, user_role, status, assigned_agent_id, subject, locale, priority, last_message_at, last_message_preview, unread_for_staff, csat_rating, csat_comment, created_at";

export const listSupportConversations = defineTool({
  name: "list_support_conversations",
  title: "List support conversations",
  description:
    "List support conversations by latest activity (read-only). Status: bot | waiting (needs a human) | assigned | resolved. Filters: status, user_id, assigned_agent_id, priority, created_from/to. Returns subject, last message preview, CSAT, unread counts.",
  roles: [...ROLES],
  input: {
    status: z.enum(["bot", "waiting", "assigned", "resolved"]).optional(),
    user_id: uuidField("The customer/rider/merchant/agent who opened it").optional(),
    assigned_agent_id: uuidField("Staff member it is assigned to").optional(),
    priority: z.string().max(20).optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin.from("support_conversations").select(CONV_COLS, { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.user_id) q = q.eq("user_id", a.user_id);
    if (a.assigned_agent_id) q = q.eq("assigned_agent_id", a.assigned_agent_id);
    if (a.priority) q = q.eq("priority", a.priority);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("last_message_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getSupportConversation = defineTool({
  name: "get_support_conversation",
  title: "Get support conversation",
  description:
    "One support conversation (read-only) with its newest 100 messages returned oldest-to-newest: {sender: user|bot|agent|system, body (cut at 2000 chars), created_at}, plus the requester's name and role. `messages_total` says how many exist.",
  roles: [...ROLES],
  input: { conversation_id: uuidField("Conversation id") },
  handler: async ({ conversation_id }) => {
    const { data: conv } = must(
      await supabaseAdmin.from("support_conversations").select(CONV_COLS).eq("id", conversation_id).maybeSingle()
    );
    if (!conv) throw new Error("Conversation not found");
    const [msgs, user] = await Promise.all([
      supabaseAdmin
        .from("support_messages")
        .select("id, sender, sender_id, body, created_at", { count: "exact" })
        .eq("conversation_id", conversation_id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin.from("users").select("id, first_name, last_name, role").eq("id", (conv as { user_id: string }).user_id).maybeSingle(),
    ]);
    const m = must(msgs);
    const messages = (m.data as unknown as { body: string }[])
      .map((x) => ({ ...x, body: x.body.length > 2000 ? `${x.body.slice(0, 2000)}…` : x.body }))
      .reverse();
    return {
      data: { conversation: conv, user: user.data ?? null, messages_total: m.count, messages },
      rowCount: messages.length,
    };
  },
});
