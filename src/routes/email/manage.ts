import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

async function getThread(id: string): Promise<{ id: string; status: string } | null> {
  const { data } = await supabaseAdmin
    .from("email_threads")
    .select("id, status")
    .eq("id", id)
    .maybeSingle();
  return (data as { id: string; status: string } | null) ?? null;
}

// POST /email/threads/:id/assign — the calling agent claims the thread.
app.post("/threads/:id/assign", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!(await getThread(id))) return c.json({ error: "Thread not found" }, 404);

  const { error } = await supabaseAdmin
    .from("email_threads")
    .update({ status: "assigned", assigned_agent_id: user.id, unread_for_staff: 0 })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

// POST /email/threads/:id/resolve — close the thread (a new inbound reopens it).
app.post("/threads/:id/resolve", async (c) => {
  const id = c.req.param("id");
  if (!(await getThread(id))) return c.json({ error: "Thread not found" }, 404);

  const { error } = await supabaseAdmin
    .from("email_threads")
    .update({ status: "closed" })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

// POST /email/threads/:id/read — clear the staff unread counter.
app.post("/threads/:id/read", async (c) => {
  const id = c.req.param("id");
  const { error } = await supabaseAdmin
    .from("email_threads")
    .update({ unread_for_staff: 0 })
    .eq("id", id);
  if (error) return c.json({ error: error.message }, 400);
  return c.json({ ok: true });
});

export default app;
