import { broadcastNotification } from "../../lib/notifications";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  BroadcastTestNotificationResponse,
  broadcastTestNotificationSchema,
} from "../../validators/notifications";

const app = router();

// ─── Broadcast test: create + push a notification to EVERY user in the target
// roles ──────────────────────────────────────────────────────────────────────
// Inserts one shared content row, one recipient row per user (bulk), then fans
// out a push to each user's devices. Verifies the broadcast pipeline end to end.
// Powerful — it writes to and pushes every targeted user — so it's a dev/test
// trigger, not a per-user action. `roles` defaults to all four.
const route = createRoute({
  method: "post",
  path: "/broadcast-test",
  operationId: "broadcastTestNotification",
  tags: ["admin-notifications"],
  security: bearer,
  // Optional body — a bare POST uses every default.
  request: { body: { ...json(broadcastTestNotificationSchema), required: false } },
  responses: { 200: json(BroadcastTestNotificationResponse), 400: errorResponses[400] },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  // Re-parse: without a JSON content-type the validator yields `{}` unparsed,
  // so this applies the schema defaults (as the bare-POST path always did).
  const body = broadcastTestNotificationSchema.parse(c.req.valid("json"));

  const recipients = await broadcastNotification(body.roles, {
    type: body.type,
    title: body.title,
    description: body.description,
    href: body.href ?? null,
    payload: body.payload ?? null,
    createdBy: user.id,
  });

  return c.json({ recipients, roles: body.roles }, 200);
});

export default app;
