import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import admin from "./admin";
import zones from "./zones";

// Pricing config console (spec: blink/docs/superpowers/specs/
// 2026-10-18-pricing-config-design.md). Staff-only; each endpoint carries its
// own requireStaffRole. The app-facing quotes live in /orders and /transactions.
const app = router();

app.use("/*", auth);
app.route("/", admin);
app.route("/", zones);

export default app;
