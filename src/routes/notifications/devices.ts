import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  DeviceResponse,
  NotificationMessageResponse,
  registerDeviceSchema,
  unregisterDeviceSchema,
} from "../../validators/notifications";

const app = router();

// ─── Register (upsert) a device push token ───────────────────────────
// The same physical device keeps a stable Expo token, so we upsert on `token`
// and re-point it at the current user (handles account switching on a device).
const registerRoute = createRoute({
  method: "post",
  path: "/devices",
  operationId: "registerDevice",
  tags: ["notifications"],
  security: bearer,
  request: { body: { ...json(registerDeviceSchema), required: true } },
  responses: { 200: json(DeviceResponse), 400: errorResponses[400] },
});

app.openapi(registerRoute, async (c) => {
  const user = c.get("user");
  const { token, platform } = c.req.valid("json");

  const { data, error } = await supabaseAdmin
    .from("device_tokens")
    .upsert(
      { user_id: user.id, token, platform: platform ?? null },
      { onConflict: "token" }
    )
    .select()
    .single();

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ device: data }, 200);
});

// ─── Unregister a device push token ──────────────────────────────────
const unregisterRoute = createRoute({
  method: "delete",
  path: "/devices",
  operationId: "unregisterDevice",
  tags: ["notifications"],
  security: bearer,
  request: { body: { ...json(unregisterDeviceSchema), required: true } },
  responses: { 200: json(NotificationMessageResponse), 400: errorResponses[400] },
});

app.openapi(unregisterRoute, async (c) => {
  const user = c.get("user");
  const { token } = c.req.valid("json");

  const { error } = await supabaseAdmin
    .from("device_tokens")
    .delete()
    .eq("token", token)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Device unregistered" }, 200);
});

export default app;
