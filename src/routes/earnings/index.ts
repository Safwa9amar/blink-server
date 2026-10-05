import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import rider from "./rider";
import agent from "./agent";

const app = router();

app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", rider);
app.route("/", agent);

export default app;
