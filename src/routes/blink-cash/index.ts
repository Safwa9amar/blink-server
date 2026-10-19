import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import admin from "./admin";
import adminLedger from "./admin-ledger";
import adminSettings from "./admin-settings";
import adminTransactions from "./admin-transactions";
import adminWallets from "./admin-wallets";
import offers from "./offers";
import settings from "./settings";

const app = router();

// Staff routes carry their own requireStaffRole guard; the app-facing reads
// only need a signed-in user (offers: rider).
app.use("/*", auth);
app.route("/", admin);
app.route("/", adminSettings);
app.route("/", adminWallets);
app.route("/", adminTransactions);
app.route("/", adminLedger);
// App-facing reads (any signed-in role / rider).
app.route("/", settings);
app.route("/", offers);

export default app;
