import { Hono } from "hono";
import { auth, type AuthEnv } from "../../middleware/auth";
import rider from "./rider";
import agent from "./agent";

const app = new Hono<AuthEnv>();

app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", rider);
app.route("/", agent);

export default app;
