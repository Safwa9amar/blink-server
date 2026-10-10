import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import quote from "./quote";
import create from "./create";

// Ride requests (passenger moto-taxi) — spec: blink/docs/superpowers/specs/
// 2026-10-09-ride-requests-design.md. Tracking, cancel and rating reuse
// /orders/*; the rider side is /riders/jobs/*.
const app = router();

app.use("/*", auth);

app.route("/", quote);
app.route("/", create);

export default app;
