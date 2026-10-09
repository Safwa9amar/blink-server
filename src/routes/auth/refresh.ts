import { createAuthClient } from "../../lib/supabase";
import { createRoute, errorResponses, json, router } from "../../openapi";
import { refreshSchema, SessionTokensResponse } from "../../validators/auth";

const app = router();

// ─── Refresh Token ───────────────────────────────────────────────────
const route = createRoute({
  method: "post",
  path: "/refresh",
  operationId: "refreshSession",
  tags: ["auth"],
  request: { body: { ...json(refreshSchema), required: true } },
  responses: {
    200: json(SessionTokensResponse),
    400: errorResponses[400],
    401: errorResponses[401],
  },
});

app.openapi(route, async (c) => {
  const { refresh_token } = c.req.valid("json");

  if (!refresh_token) {
    return c.json({ error: "refresh_token is required" }, 400);
  }

  const { data, error } = await createAuthClient().auth.refreshSession({
    refresh_token,
  });

  if (error || !data.session) {
    return c.json({ error: error?.message ?? "Could not refresh session" }, 401);
  }

  return c.json(
    {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
    200
  );
});

export default app;
