import { Hono } from "hono";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { toolsForRole } from "../../mcp/registry";
import { ALL_TOOLS } from "../../mcp/tools";
import type { AuthEnv } from "../../middleware/auth";
import { getAssistantSettings } from "./settings";

const app = new Hono<AuthEnv>();

const THREAD_COLS = "id, title, created_at, updated_at";
const titleSchema = z.string().trim().min(1).max(120);

/** The thread when it belongs to `userId`, else null (callers answer 404). */
export async function ownThread(id: string, userId: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const { data } = await supabaseAdmin
    .from("staff_assistant_threads")
    .select(THREAD_COLS + ", user_id")
    .eq("id", id)
    .maybeSingle();
  const row = data as unknown as { id: string; title: string | null; created_at: string; updated_at: string; user_id: string } | null;
  return row && row.user_id === userId ? row : null;
}

function publicThread(t: { id: string; title: string | null; created_at: string; updated_at: string }) {
  return { id: t.id, title: t.title, created_at: t.created_at, updated_at: t.updated_at };
}

app.get("/config", async (c) => {
  const s = await getAssistantSettings();
  const role = c.get("user").staff_role!;
  return c.json({
    enabled: s.enabled,
    provider: s.provider,
    model: s.model,
    tools: toolsForRole(ALL_TOOLS, role).map((t) => ({ name: t.name, title: t.title })),
  });
});

app.get("/threads", async (c) => {
  const { data, error } = await supabaseAdmin
    .from("staff_assistant_threads")
    .select(THREAD_COLS)
    .eq("user_id", c.get("userId"))
    .order("updated_at", { ascending: false })
    .limit(50);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ threads: (data ?? []).map(publicThread) });
});

app.post("/threads", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = z.object({ title: z.string().trim().max(120).optional() }).safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const { data, error } = await supabaseAdmin
    .from("staff_assistant_threads")
    .insert({ user_id: c.get("userId"), title: parsed.data.title || null })
    .select(THREAD_COLS)
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "Could not create thread" }, 500);
  return c.json({ thread: publicThread(data) }, 201);
});

app.patch("/threads/:id", async (c) => {
  const t = await ownThread(c.req.param("id"), c.get("userId"));
  if (!t) return c.json({ error: "Thread not found" }, 404);
  const parsed = z.object({ title: titleSchema }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const { data, error } = await supabaseAdmin
    .from("staff_assistant_threads")
    .update({ title: parsed.data.title })
    .eq("id", t.id)
    .select(THREAD_COLS)
    .single();
  if (error || !data) return c.json({ error: error?.message ?? "Update failed" }, 500);
  return c.json({ thread: publicThread(data) });
});

app.delete("/threads/:id", async (c) => {
  const t = await ownThread(c.req.param("id"), c.get("userId"));
  if (!t) return c.json({ error: "Thread not found" }, 404);
  const { error } = await supabaseAdmin.from("staff_assistant_threads").delete().eq("id", t.id);
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ ok: true });
});

export interface FoldRow {
  id: number;
  role: string;
  content: string | null;
  tool_calls?: unknown;
  tool_name?: string | null;
  tool_ok?: boolean | null;
  row_count?: number | null;
  created_at: string;
}

/** Fold stored rows into UI messages: tool rows become the `tools` summary of the assistant message that follows. */
export function foldMessages(rows: readonly FoldRow[]) {
  const titleOf = (n: string) => ALL_TOOLS.find((t) => t.name === n)?.title ?? n;
  const out: {
    id: number;
    role: "user" | "assistant";
    content: string;
    tools: { name: string; title: string; ok: boolean; row_count: number | null }[] | null;
    created_at: string;
  }[] = [];
  let tools: NonNullable<(typeof out)[number]["tools"]> = [];
  let text = "";
  for (const r of rows) {
    if (r.role === "user") {
      out.push({ id: r.id, role: "user", content: r.content ?? "", tools: null, created_at: r.created_at });
    } else if (r.role === "tool") {
      const name = r.tool_name ?? "tool";
      tools.push({ name, title: titleOf(name), ok: r.tool_ok ?? true, row_count: r.row_count ?? null });
    } else if (r.role === "assistant") {
      text += (text && r.content ? "\n\n" : "") + (r.content ?? "");
      const hasCalls = Array.isArray(r.tool_calls) && r.tool_calls.length > 0;
      if (hasCalls) continue; // keep folding until the final answer
      out.push({ id: r.id, role: "assistant", content: text, tools: tools.length ? tools : null, created_at: r.created_at });
      tools = [];
      text = "";
    }
  }
  return out;
}

app.get("/threads/:id/messages", async (c) => {
  const t = await ownThread(c.req.param("id"), c.get("userId"));
  if (!t) return c.json({ error: "Thread not found" }, 404);
  const { data, error } = await supabaseAdmin
    .from("staff_assistant_messages")
    .select("id, role, content, tool_calls, tool_name, tool_ok, row_count, created_at")
    .eq("thread_id", t.id)
    .order("id", { ascending: true });
  if (error) return c.json({ error: error.message }, 500);
  return c.json({ messages: foldMessages((data ?? []) as FoldRow[]) });
});

export default app;
