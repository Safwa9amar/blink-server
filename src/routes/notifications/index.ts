import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import list from "./list";
import detail from "./detail";
import read from "./read";
import readAll from "./read-all";
import devices from "./devices";
import test from "./test";
import broadcastTest from "./broadcast-test";
import del from "./delete";
import restore from "./restore";
import adminSms from "./admin-sms";

const app = router();

app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
// Static-path routers (devices, test, read-all) are registered before the
// `/:id` param routers (detail, read, delete) so e.g. DELETE /devices and
// PATCH /read-all aren't swallowed by the `:id` matchers.
app.route("/", adminSms);
app.route("/", devices);
app.route("/", test);
app.route("/", broadcastTest);
app.route("/", readAll);
app.route("/", list);
app.route("/", detail);
app.route("/", read);
app.route("/", restore);
app.route("/", del);

export default app;
