import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { emailListSchema } from "../../validators/email";
import { MESSAGE_COLUMNS, THREAD_COLUMNS } from "../../lib/email/shared";

const app = new Hono<AuthEnv>();

// GET /email/threads — inbox list (newest activity first), optional status filter.
app.get("/threads", async (c) => {
  const { status, page, limit } = emailListSchema.parse(c.req.query());
  const offset = (page - 1) * limit;

  let query = supabaseAdmin
    .from("email_threads")
    .select(THREAD_COLUMNS, { count: "exact" })
    .order("last_message_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) query = query.eq("status", status);

  const { data, error, count } = await query;
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ threads: data ?? [], pagination: { page, limit, total: count ?? 0 } });
});

// GET /email/threads/:id — thread + its messages (oldest first). Opening the
// thread reads it, so the staff unread counter is cleared.
app.get("/threads/:id", async (c) => {
  const id = c.req.param("id");

  const { data: thread, error: tErr } = await supabaseAdmin
    .from("email_threads")
    .select(THREAD_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (tErr) return c.json({ error: tErr.message }, 400);
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const { data: messages, error: mErr } = await supabaseAdmin
    .from("email_messages")
    .select(MESSAGE_COLUMNS)
    .eq("thread_id", id)
    .order("created_at", { ascending: true });
  if (mErr) return c.json({ error: mErr.message }, 400);

  if ((thread as { unread_for_staff: number }).unread_for_staff > 0) {
    await supabaseAdmin.from("email_threads").update({ unread_for_staff: 0 }).eq("id", id);
  }

  return c.json({ thread, messages: messages ?? [] });
});

export default app;
