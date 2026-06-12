import { Hono } from "hono";
import { broadcastNotification } from "../../lib/notifications";
import type { AuthEnv } from "../../middleware/auth";
import { broadcastTestNotificationSchema } from "../../validators/notifications";

const app = new Hono<AuthEnv>();

// ─── Broadcast test: create + push a notification to EVERY user in the target
// roles ──────────────────────────────────────────────────────────────────────
// Inserts one shared content row, one recipient row per user (bulk), then fans
// out a push to each user's devices. Verifies the broadcast pipeline end to end.
// Powerful — it writes to and pushes every targeted user — so it's a dev/test
// trigger, not a per-user action. `roles` defaults to all four.
app.post("/broadcast-test", async (c) => {
  const user = c.get("user");
  const body = broadcastTestNotificationSchema.parse(
    await c.req.json().catch(() => ({}))
  );

  const recipients = await broadcastNotification(body.roles, {
    type: body.type,
    title: body.title,
    description: body.description,
    href: body.href ?? null,
    payload: body.payload ?? null,
    createdBy: user.id,
  });

  return c.json({ recipients, roles: body.roles });
});

export default app;
