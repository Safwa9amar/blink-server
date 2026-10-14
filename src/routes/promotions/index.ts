import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import list from "./list";
import detail from "./detail";
import activate from "./activate";
import events from "./events";

const app = router();

app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", events);
app.route("/", detail);
app.route("/", activate);

export default app;
