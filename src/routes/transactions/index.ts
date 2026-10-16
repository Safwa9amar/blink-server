import { auth } from "../../middleware/auth";
import { requireVerifiedPartner } from "../../lib/verified-account";
import { router } from "../../openapi";
import list from "./list";
import detail from "./detail";
import deposit from "./deposit";
import withdrawal from "./withdrawal";
import process from "./process";
import scanQr from "./scan-qr";
import rate from "./rate";
import rateRider from "./rate-rider";
import setShop from "./set-shop";
import cancel from "./cancel";

const app = router();

app.use("/*", auth);
// A partner (active role rider / agent / merchant) whom Blink hasn't verified can't operate here.
app.use("/*", requireVerifiedPartner({ prefix: "/transactions" }));

// Each endpoint lives in its own file and is mounted at the router root,
// in the same order the routes were originally declared (order matters
// for route matching).
app.route("/", list);
app.route("/", detail);
app.route("/", deposit);
app.route("/", withdrawal);
app.route("/", process);
app.route("/", scanQr);
app.route("/", rate);
app.route("/", rateRider);
app.route("/", setShop);
app.route("/", cancel);

export default app;
