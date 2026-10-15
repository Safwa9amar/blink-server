import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import admin from "./admin";

const app = router();

// Staff only — the route carries its own requireStaffRole guard.
app.use("/*", auth);
app.route("/", admin);

export default app;
