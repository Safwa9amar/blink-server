import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { MessageResponse, setupPinSchema } from "../../validators/auth";
import { hashPin } from "../../lib/pin";

const app = router();

// ─── Setup PIN ───────────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/pin/setup",
  operationId: "setupPin",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(setupPinSchema), required: true } },
  responses: {
    200: json(MessageResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const userId = c.get("userId");

  const pinHash = await hashPin(body.pin);

  const { error } = await supabaseAdmin
    .from("users")
    .update({ pin_hash: pinHash })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  return c.json({ message: "PIN set successfully" }, 200);
});

export default app;
