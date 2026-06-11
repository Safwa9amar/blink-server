import { Hono } from "hono";
import { createNotification } from "../../lib/notifications";
import type { AuthEnv } from "../../middleware/auth";
import { testNotificationSchema } from "../../validators/notifications";

const app = new Hono<AuthEnv>();

// ─── Self-test: create + push a notification to the current user ─────
// Verifies the full pipeline (insert row → look up device tokens → Expo send)
// from a real device without needing the dashboard or another trigger.
app.post("/test", async (c) => {
  const user = c.get("user");
  const body = testNotificationSchema.parse(
    await c.req.json().catch(() => ({}))
  );

  const notification = await createNotification({
    userId: user.id,
    type: body.type,
    title: body.title,
    description: body.description,
    href: body.href ?? null,
    payload: body.payload ?? null,
  });

  if (!notification) {
    return c.json({ error: "Failed to create notification" }, 500);
  }

  return c.json({ notification });
});

export default app;
