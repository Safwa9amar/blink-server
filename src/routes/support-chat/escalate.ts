import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth";
import { escalateSchema } from "../../validators/support-chat";
import { escalateConversation } from "../../lib/support-chat";
import { getConversation } from "./shared";

const app = new Hono<AuthEnv>();

// POST /conversations/:id/escalate — user asks for a human.
app.post("/conversations/:id/escalate", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { reason } = escalateSchema.parse(await c.req.json().catch(() => ({})));

  const conversation = await getConversation(id);
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);
  if ((conversation as any).user_id !== user.id) return c.json({ error: "Access denied" }, 403);

  if (conversation.status === "bot" || conversation.status === "resolved") {
    await escalateConversation(conversation, reason ?? "user requested a human");
  }
  return c.json({ ok: true });
});

export default app;
