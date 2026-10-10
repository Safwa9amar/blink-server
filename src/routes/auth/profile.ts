import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { AuthProfileResponse } from "../../validators/auth";
import { authProfilePayload } from "./profile-payload";

const app = router();

// ─── Get Profile ─────────────────────────────────────────────────────
// The user row (incl. granted_roles) plus the rows of the ACTIVE role. The app
// refetches this on every foreground to pick up a role switch made on another
// device.
const route = createRoute({
  method: "get",
  path: "/profile",
  operationId: "getAuthProfile",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  responses: {
    200: json(AuthProfileResponse),
    401: errorResponses[401],
    404: errorResponses[404],
  },
});

app.openapi(route, async (c) => {
  return c.json(await authProfilePayload(c.get("user")), 200);
});

export default app;
