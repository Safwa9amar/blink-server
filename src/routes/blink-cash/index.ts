import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import admin from "./admin";
import offers from "./offers";
import settings from "./settings";

const app = router();

// Staff only — the route carries its own requireStaffRole guard.
app.use("/*", auth);
app.route("/", admin);
// App-facing reads (any signed-in role / rider).
app.route("/", settings);
app.route("/", offers);

export default app;
