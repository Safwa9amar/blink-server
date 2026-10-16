import { getBlinkCashSettings, publicSettings } from "../../lib/blink-cash-settings";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { BlinkCashSettingsResponse } from "../../validators/blink-cash-public";

const app = router();

// ─── GET /blink-cash/settings — the public subset, any signed-in role ─
// Fees, limits, quick amounts, expiry, the electronic flag + accounts, the PIN
// requirement and the dues payment methods. Cached server-side for 30 s.
app.openapi(
  createRoute({
    method: "get",
    path: "/settings",
    operationId: "getBlinkCashSettings",
    tags: ["blink-cash"],
    security: bearer,
    responses: { 200: json(BlinkCashSettingsResponse), 401: errorResponses[401] },
  }),
  async (c) => c.json({ settings: publicSettings(await getBlinkCashSettings()) }, 200)
);

export default app;
