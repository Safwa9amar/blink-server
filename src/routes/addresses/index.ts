import { Hono } from "hono";
import { auth, requireRole, type AuthEnv } from "../../middleware/auth";
import list from "./list";
import create from "./create";
import update from "./update";
import del from "./delete";

const app = new Hono<AuthEnv>();

app.use("/*", auth, requireRole("customer"));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", create);
app.route("/", update);
app.route("/", del);

export default app;
