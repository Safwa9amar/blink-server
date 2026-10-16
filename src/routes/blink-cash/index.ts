import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import admin from "./admin";
import adminLedger from "./admin-ledger";
import adminSettings from "./admin-settings";
import adminTransactions from "./admin-transactions";
import adminWallets from "./admin-wallets";

const app = router();

// Staff only — each route carries its own requireStaffRole guard.
app.use("/*", auth);
app.route("/", admin);
app.route("/", adminSettings);
app.route("/", adminWallets);
app.route("/", adminTransactions);
app.route("/", adminLedger);

export default app;
