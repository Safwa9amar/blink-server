// Rider activation checklist — derived from the rider's real data (vehicle
// type, licence, national ID, overall verification) so the app's Required
// Actions screen and home banner can't drift from it. Rules:
// riderRequiredActions in src/lib/rider-verification.ts.
import { riderRequiredActions } from "../../lib/rider-verification";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import { RiderRequiredActionsResponse } from "../../validators/riders";
import { loadRiderVerification, RiderDataUnavailableError } from "./verification-shared";

const app = router();

app.openapi(
  createRoute({
    method: "get",
    path: "/required-actions",
    operationId: "getRiderRequiredActions",
    tags: ["riders"],
    security: bearer,
    responses: {
      200: json(RiderRequiredActionsResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    try {
      const current = await loadRiderVerification(user.id);
      return c.json(
        riderRequiredActions({
          vehicleType: current?.vehicle_type ?? null,
          documents: current?.documents ?? {},
          verificationStatus: current?.verification_status ?? "not_submitted",
        }),
        200
      );
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return c.json({ error: "Service unavailable, please retry" }, 503);
      throw e;
    }
  }
);

export default app;
