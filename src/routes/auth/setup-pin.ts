import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { setupPinSchema } from "../../validators/auth";
import { hashPin } from "../../lib/pin";

const app = new Hono<AuthEnv>();

// ─── Setup PIN ───────────────────────────────────────────────────────
app.post("/pin/setup", auth, async (c) => {
  const body = setupPinSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const pinHash = await hashPin(body.pin);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ pin_hash: pinHash })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "PIN set successfully" });
});

export default app;
