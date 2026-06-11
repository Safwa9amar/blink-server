import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import {
  registerDeviceSchema,
  unregisterDeviceSchema,
} from "../../validators/notifications";

const app = new Hono<AuthEnv>();

// ─── Register (upsert) a device push token ───────────────────────────
// The same physical device keeps a stable Expo token, so we upsert on `token`
// and re-point it at the current user (handles account switching on a device).
app.post("/devices", async (c) => {
  const user = c.get("user");
  const { token, platform } = registerDeviceSchema.parse(await c.req.json());

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

  return c.json({ device: data });
});

// ─── Unregister a device push token ──────────────────────────────────
app.delete("/devices", async (c) => {
  const user = c.get("user");
  const { token } = unregisterDeviceSchema.parse(await c.req.json());

  const { error } = await supabaseAdmin
    .from("device_tokens")
    .delete()
    .eq("token", token)
    .eq("user_id", user.id);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "Device unregistered" });
});

export default app;
