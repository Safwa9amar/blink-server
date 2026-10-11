import { createRoute, ErrorSchema, errorResponses, bearer, json, router } from "../../openapi";
import { EmailAvailableResponse, emailAvailableQuerySchema } from "../../validators/auth";
import { getBearerUser, isEmailTaken } from "./shared";

const app = router();

// ─── Is this email free? ─────────────────────────────────────────────
// The sign-up details form checks the address as the user types, so a taken
// one is flagged in place instead of failing at role selection. Needs the
// session from /auth/otp/verify (not the `auth` middleware — no users row yet),
// which keeps it from being an open email-lookup service. POST /auth/otp/register
// enforces the same rule.
const route = createRoute({
  method: "get",
  path: "/email-available",
  operationId: "checkEmailAvailable",
  tags: ["auth"],
  security: bearer,
  request: { query: emailAvailableQuerySchema },
  responses: {
    200: json(EmailAvailableResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    503: json(ErrorSchema, "Supabase unreachable — safe to retry"),
  },
});

app.openapi(route, async (c) => {
  const bearerUser = await getBearerUser(c.req.header("Authorization"));
  if ("error" in bearerUser) return c.json({ error: bearerUser.error }, bearerUser.status);

  const { email } = c.req.valid("query");
  try {
    const taken = await isEmailTaken(email, bearerUser.user.id);
    return c.json({ available: !taken }, 200);
  } catch {
    return c.json({ error: "Service temporarily unavailable, please retry" }, 503);
  }
});

export default app;
