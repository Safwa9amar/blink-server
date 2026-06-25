import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff, type AuthEnv } from "../../middleware/auth";
import { staffListSchema } from "../../validators/support-chat";
import { insertMessage, CONVERSATION_COLUMNS } from "../../lib/support-chat";
import { getConversation } from "./shared";

const app = new Hono<AuthEnv>();

// GET /staff/conversations — inbox list (staff only).
app.get("/staff/conversations", requireStaff(), async (c) => {
  const { status, page, limit } = staffListSchema.parse(c.req.query());
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("support_conversations")
    .select(CONVERSATION_COLUMNS, { count: "exact" })
    .order("last_message_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ conversations: data ?? [], pagination: { page, limit, total: count ?? 0 } });
});

// POST /conversations/:id/assign — staff claims the thread.
app.post("/conversations/:id/assign", requireStaff(), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const { error } = await supabaseAdmin
    .from("support_conversations")
    .update({ status: "assigned", assigned_agent_id: user.id, unread_for_staff: 0 })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);

  const name = (user as any).full_name ?? "Support";
  await insertMessage(id, "system", user.id, "joined", { type: "assigned", agentName: name });
  return c.json({ ok: true });
});

// POST /conversations/:id/resolve — staff closes the thread.
app.post("/conversations/:id/resolve", requireStaff(), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  const { error } = await supabaseAdmin
    .from("support_conversations")
    .update({ status: "resolved" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);

  await insertMessage(id, "system", user.id, "resolved", { type: "resolved" });
  return c.json({ ok: true });
});

export default app;
