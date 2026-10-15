import { auth, requireRole } from "../../middleware/auth";
import { router } from "../../openapi";
import overview from "./overview";
import apply from "./apply";

const app = router();

app.use("/*", auth, requireRole("customer"));

app.route("/", overview);
app.route("/", apply);

export default app;
