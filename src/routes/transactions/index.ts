import { Hono } from "hono";
import { auth, type AuthEnv } from "../../middleware/auth";
import list from "./list";
import detail from "./detail";
import deposit from "./deposit";
import withdrawal from "./withdrawal";
import process from "./process";
import scanQr from "./scan-qr";
import rate from "./rate";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

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

export default app;
