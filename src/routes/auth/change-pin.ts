import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { changePinSchema, MessageResponse } from "../../validators/auth";
import { PinError } from "../../validators/transactions";
import { checkPin, hashPin, PIN_UNLOCKED, pinFailureBody } from "../../lib/pin";

const app = router();

// ─── Change PIN ──────────────────────────────────────────────────────
// Needs the current PIN (counted toward the lockout like any other check).
// Setup (/pin/setup) keeps overwriting, because the apps mirror the local PIN.
const route = createRoute({
  method: "post",
  path: "/pin/change",
  operationId: "changePin",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(changePinSchema), required: true } },
  responses: {
    200: json(MessageResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(PinError, "Wrong current PIN, or pin_locked (with retry_after seconds)"),
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");

  const result = await checkPin(user, body.current_pin);
  if (!result.ok) {
    const f = pinFailureBody(result);
    return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
  }
  if (body.new_pin === body.current_pin) {
    return c.json({ error: "The new PIN must be different" }, 400);
  }

  const { error } = await supabaseAdmin
    .from("users")
    .update({ pin_hash: await hashPin(body.new_pin), ...PIN_UNLOCKED })
    .eq("id", user.id);
  if (error) return c.json({ error: error.message }, 400);

  return c.json({ message: "PIN changed successfully" }, 200);
});

export default app;
