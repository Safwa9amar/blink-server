import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { buildProviderFor } from "../../lib/ai-settings";
import { RateLimiter } from "../../lib/mcp-util";
import { AssistantError, runAssistantTurn, type StoredRow } from "../../lib/assistant";
import type { McpContext } from "../../mcp/registry";
import type { AuthEnv } from "../../middleware/auth";
import { getAssistantSettings } from "./settings";
import { ownThread } from "./threads";

const app = new Hono<AuthEnv>();
const limiter = new RateLimiter(20, 60_000);

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4000),
  locale: z.enum(["en", "fr", "ar"]).optional(),
});

const HISTORY_FETCH = 80;

export function titleFrom(message: string): string {
  const t = message.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 59).trimEnd()}…` : t;
}

app.post("/threads/:id/chat", async (c) => {
  const user = c.get("user");
  const settings = await getAssistantSettings();
  if (!settings.enabled) return c.json({ error: "The assistant is disabled.", code: "disabled" }, 403);

  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);
  const { message, locale } = parsed.data;
  const threadId = c.req.param("id");

  return streamSSE(c, async (stream) => {
    // Serialise writes so delta/tool events keep their order relative to done/error.
    let queue: Promise<unknown> = Promise.resolve();
    const send = (event: string, data: unknown): Promise<unknown> =>
      (queue = queue.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined));
    const fail = (code: string, msg: string) => send("error", { message: msg, code });

    if (!limiter.take(`user:${user.id}`)) return void (await fail("rate_limited", "Too many messages. Wait a moment and retry."));
    const thread = await ownThread(threadId, user.id);
    if (!thread) return void (await fail("not_found", "Thread not found."));

    const ac = new AbortController();
    stream.onAbort(() => ac.abort());

    // History before this message.
    const { data: histDesc } = await supabaseAdmin
      .from("staff_assistant_messages")
      .select("role, content, tool_calls, tool_call_id")
      .eq("thread_id", thread.id)
      .order("id", { ascending: false })
      .limit(HISTORY_FETCH);
    const stored = (histDesc ?? []) as unknown as StoredRow[]; // newest first
    // A retry after a failed turn re-sends the same text: the user row from the
    // failed attempt is already the last row (nothing answered it), so reuse it
    // instead of storing the question twice.
    const isRetry = stored[0]?.role === "user" && stored[0]?.content === message;
    const history = (isRetry ? stored.slice(1) : stored).reverse();

    if (!isRetry) {
      const { error: userErr } = await supabaseAdmin
        .from("staff_assistant_messages")
        .insert({ thread_id: thread.id, role: "user", content: message });
      if (userErr) return void (await fail("provider_error", "Could not save your message."));
    }
    if (!thread.title) {
      await supabaseAdmin.from("staff_assistant_threads").update({ title: titleFrom(message) }).eq("id", thread.id);
    }

    const ctx: McpContext = {
      tokenId: null,
      user: { id: user.id, first_name: user.first_name, last_name: user.last_name, staff_role: user.staff_role! },
      staffRole: user.staff_role!,
    };

    try {
      const provider = await buildProviderFor(settings.provider);
      const result = await runAssistantTurn({
        ctx,
        provider,
        model: settings.model,
        history,
        userMessage: message,
        locale,
        signal: ac.signal,
        emit: (e) => {
          if (e.type === "delta") void send("delta", { text: e.text });
          else {
            const { type: _t, ...rest } = e;
            void send("tool", rest);
          }
        },
      });

      const rows = result.messages.map((m) => ({
        thread_id: thread.id,
        role: m.role,
        content: m.content,
        tool_calls: m.tool_calls ?? null,
        tool_call_id: m.tool_call_id ?? null,
        tool_name: m.tool_name ?? null,
        tool_ok: m.tool_ok ?? null,
        row_count: m.row_count ?? null,
      }));
      const { data: saved, error } = await supabaseAdmin.from("staff_assistant_messages").insert(rows).select("id, role");
      if (error) return void (await fail("provider_error", "Could not save the answer."));
      await supabaseAdmin.from("staff_assistant_threads").update({ updated_at: new Date().toISOString() }).eq("id", thread.id);
      const last = [...(saved ?? [])].reverse().find((r) => r.role === "assistant");
      await send("done", { message_id: last?.id ?? null });
    } catch (err) {
      if (err instanceof AssistantError) {
        if (err.code === "aborted") return; // client left
        await fail(err.code, err.message);
      } else {
        console.error("[assistant/chat] failed", (err as Error).message);
        await fail("provider_error", "The assistant failed. Please retry.");
      }
    }
  });
});

export default app;
