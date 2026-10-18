import { quoteBlinkCashFee } from "../../lib/pricing/fees";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { QuoteTransactionBody, QuoteTransactionResponse } from "../../validators/pricing";

const app = router();

// ─── POST /transactions/quote — Blink Cash fee for an amount (rider) ──
// POST /transactions/deposit and /withdrawal charge the same fee.
const route = createRoute({
  method: "post",
  path: "/quote",
  operationId: "quoteTransaction",
  tags: ["transactions"],
  security: bearer,
  middleware: [requireRole("rider")] as const,
  request: { body: { ...json(QuoteTransactionBody), required: true } },
  responses: {
    200: json(QuoteTransactionResponse),
    400: errorResponses[400],
    403: errorResponses[403],
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { type, amount } = c.req.valid("json");
  const { fees, total, fee_rate } = await quoteBlinkCashFee({ type, amount, riderId: user.id });
  return c.json({ fees, total, fee_rate }, 200);
});

export default app;
