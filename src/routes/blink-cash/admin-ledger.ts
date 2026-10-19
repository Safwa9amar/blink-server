// Ledger backfill (one-off, super_admin) and reconciliation (spec §1). Tagged
// admin-* so orval skips it.
import { backfillWallets, reconcileWallets } from "../../lib/blink-ledger";
import { riderWalletDerived } from "../../lib/dispatch";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { BackfillResponse, ReconciliationResponse } from "../../validators/blink-cash-admin";
import { staff } from "./admin-shared";

const app = router();

const TAG = ["admin-blink-cash"];
// Reconciliation compares the ledger with the derived formula, never with
// riderWallet (which reads the ledger once a wallet is backfilled).
const derived = riderWalletDerived;

// requireStaffRole always lets super_admin through; with no extra roles it is super_admin only.
const superOnly = requireStaffRole();

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/ledger/backfill",
    operationId: "backfillBlinkCashLedgerAdmin",
    tags: TAG,
    security: bearer,
    middleware: [superOnly] as const,
    responses: { 200: json(BackfillResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const actor = c.get("user");
    const result = await backfillWallets();
    await recordFinanceAudit({
      actorId: actor.id,
      action: "ledger.backfill",
      targetType: "ledger",
      targetId: "riders",
      details: { ...result, failed: result.failed.slice(0, 20), failed_count: result.failed.length },
    });
    return c.json(result, 200);
  }
);

app.openapi(
  createRoute({
    method: "get",
    path: "/admin/reconciliation",
    operationId: "getBlinkCashReconciliationAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    responses: { 200: json(ReconciliationResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => c.json(await reconcileWallets(derived), 200)
);

export default app;
