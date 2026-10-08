import { auth, requireRole } from "../../middleware/auth";
import { router } from "../../openapi";
import list from "./list";
import add from "./add";
import remove from "./remove";

const app = router();

app.use("/*", auth, requireRole("customer"));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", add);
app.route("/", remove);

export default app;
