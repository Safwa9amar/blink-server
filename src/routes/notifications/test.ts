import { createNotification } from "../../lib/notifications";
import type { UserRole } from "../../db";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  TestNotificationResponse,
  testNotificationSchema,
} from "../../validators/notifications";

const app = router();

// ─── Self-test: create + push a notification to the current user ─────
// Verifies the full pipeline (insert row → look up device tokens → Expo send)
// from a real device without needing the dashboard or another trigger.
const route = createRoute({
  method: "post",
  path: "/test",
  operationId: "sendTestNotification",
  tags: ["admin-notifications"],
  security: bearer,
  // Optional body — a bare POST uses every default.
  request: { body: { ...json(testNotificationSchema), required: false } },
  responses: {
    200: json(TestNotificationResponse),
    400: errorResponses[400],
    500: json(ErrorSchema, "Failed to create notification"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  // Re-parse: without a JSON content-type the validator yields `{}` unparsed,
  // so this applies the schema defaults (as the bare-POST path always did).
  const body = testNotificationSchema.parse(c.req.valid("json"));

  const notification = await createNotification({
    userId: user.id,
    role: user.role as UserRole,
    type: body.type,
    title: body.title,
    description: body.description,
    href: body.href ?? null,
    payload: body.payload ?? null,
  });

  if (!notification) {
    return c.json({ error: "Failed to create notification" }, 500);
  }

  // Type-only cast: `createNotification` is typed with Drizzle's camelCase row,
  // but it returns the PostgREST (snake_case) row the schema describes.
  return c.json({ notification: notification as any }, 200);
});

export default app;
