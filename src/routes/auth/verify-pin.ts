import { Hono } from "hono";
import { auth, type AuthEnv } from "../../middleware/auth";
import { verifyPinSchema } from "../../validators/auth";
import { verifyPin } from "../../lib/pin";

const app = new Hono<AuthEnv>();

// ─── Verify PIN ──────────────────────────────────────────────────────
app.post("/pin/verify", auth, async (c) => {
  const body = verifyPinSchema.parse(await c.req.json());
  const user = c.get("user");

  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }

  const valid = await verifyPin(body.pin, user.pin_hash);
  if (!valid) {
    return c.json({ error: "Invalid PIN" }, 401);
  }

  return c.json({ valid: true });
});

export default app;
