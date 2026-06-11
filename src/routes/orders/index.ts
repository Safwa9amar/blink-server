import { Hono } from "hono";
import { auth, type AuthEnv } from "../../middleware/auth";
import list from "./list";
import detail from "./detail";
import create from "./create";
import updateStatus from "./update-status";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", detail);
app.route("/", create);
app.route("/", updateStatus);

export default app;
