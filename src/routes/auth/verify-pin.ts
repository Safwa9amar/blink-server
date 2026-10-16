import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { VerifyPinResponse, verifyPinSchema } from "../../validators/auth";
import { PinError } from "../../validators/transactions";
import { checkPin, pinFailureBody } from "../../lib/pin";

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
    403: json(PinError, "Wrong PIN, or pin_locked (with retry_after seconds) after 5 wrong tries"),
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  const body = c.req.valid("json");
  const user = c.get("user");

  const result = await checkPin(user, body.pin);
  if (!result.ok) {
    const f = pinFailureBody(result);
    return f.status === 403 ? c.json(f.body, 403) : c.json(f.body, 400);
  }

  return c.json({ valid: true }, 200);
});

export default app;
