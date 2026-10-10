import { auth } from "../../middleware/auth";
import { requireVerifiedPartner } from "../../lib/verified-account";
import { router } from "../../openapi";
import list from "./list";
import detail from "./detail";
import create from "./create";
import updateStatus from "./update-status";
import rate from "./rate";
import rateRider from "./rate-rider";

const app = router();

app.use("/*", auth);
// A partner (active role rider / agent / merchant) whom Blink hasn't verified can't operate here.
app.use("/*", requireVerifiedPartner({ prefix: "/orders" }));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", detail);
app.route("/", create);
app.route("/", updateStatus);
app.route("/", rate);
app.route("/", rateRider);

export default app;
