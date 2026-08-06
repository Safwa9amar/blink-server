import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth";
import { emailReplySchema } from "../../validators/email";
import { emailConfigured, sendEmailReply } from "../../lib/email/smtp";

const app = new Hono<AuthEnv>();

// POST /email/threads/:id/reply — send a staff reply over SMTP and log it.
app.post("/threads/:id/reply", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const { body } = emailReplySchema.parse(await c.req.json());

  if (!emailConfigured()) return c.json({ error: "Email is not configured" }, 503);

  // users rows come back snake_case from supabase-js (not Drizzle camelCase).
  const u = user as unknown as { first_name?: string; last_name?: string };
  const staffName =
    [u.first_name, u.last_name].filter(Boolean).join(" ") || "Blink Support";

  const { message, error } = await sendEmailReply(id, user.id, body, staffName);
  if (error) return c.json({ error }, 400);
  return c.json({ ok: true, message });
});

export default app;
