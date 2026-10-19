import { getBlinkCashSettings, publicSettings } from "../../lib/blink-cash-settings";
import { getPrice } from "../../lib/pricing";
import { userWilaya } from "../../lib/pricing/fees";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { BlinkCashSettingsResponse } from "../../validators/blink-cash-public";

const app = router();

// ─── GET /blink-cash/settings — the public subset, any signed-in role ─
// Fees, limits, quick amounts, expiry, the electronic flag + accounts, the PIN
// requirement and the dues payment methods. Cached server-side for 30 s.
// The fee rates shown are the ones a deposit / withdrawal is charged: Pricing &
// Fees' blink_cash_fee_rate for the caller's wilaya (not blink_cash_settings).
app.openapi(
  createRoute({
    method: "get",
    path: "/settings",
    operationId: "getBlinkCashSettings",
    tags: ["blink-cash"],
    security: bearer,
    responses: { 200: json(BlinkCashSettingsResponse), 401: errorResponses[401] },
  }),
  async (c) => {
    const [settings, wilaya] = await Promise.all([getBlinkCashSettings(), userWilaya(c.get("user").id)]);
    const [deposit, withdrawal] = await Promise.all([
      getPrice("blink_cash_fee_rate", { service: "deposit", wilaya }),
      getPrice("blink_cash_fee_rate", { service: "withdrawal", wilaya }),
    ]);
    return c.json(
      {
        settings: {
          ...publicSettings(settings),
          deposit_fee_rate: deposit.value.rate,
          withdrawal_fee_rate: withdrawal.value.rate,
        },
      },
      200
    );
  }
);

export default app;
