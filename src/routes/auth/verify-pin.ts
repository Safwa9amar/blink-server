import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { VerifyPinResponse, verifyPinSchema } from "../../validators/auth";
import { verifyPin } from "../../lib/pin";

const app = router();

// ─── Verify PIN ──────────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/pin/verify",
  operationId: "verifyPin",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(verifyPinSchema), required: true } },
  responses: {
    200: json(VerifyPinResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");

  if (!user.pin_hash) {
    return c.json({ error: "PIN not set up" }, 400);
  }

  const valid = await verifyPin(body.pin, user.pin_hash);
  if (!valid) {
    // 403, not 401: a wrong PIN must not look like an expired session to the
    // app (its 401 backstop signs the user out).
    return c.json({ error: "Invalid PIN" }, 403);
  }

  return c.json({ valid: true }, 200);
});

export default app;
