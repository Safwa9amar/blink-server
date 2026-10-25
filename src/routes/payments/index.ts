import { router } from "../../openapi";
import admin from "./admin";
import publicRoutes from "./public";
import user from "./user";

// Not behind a blanket `auth`: webhooks and the return page are called by the
// providers / a browser with no bearer token, so each OpenAPI route carries its
// own guards. /admin and /methods must come before /{id}.
const app = router();
app.route("/", publicRoutes);
app.route("/", admin);
app.route("/", user);

export default app;
