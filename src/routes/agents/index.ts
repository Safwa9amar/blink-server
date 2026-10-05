import { router } from "../../openapi";
import nearby from "./nearby";
import profile from "./profile";
import getShop from "./get-shop";
import updateShop from "./update-shop";

const app = router();

// Auth is applied per-endpoint inline (see each endpoint file), not app-wide.

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", nearby);
app.route("/", profile);
app.route("/", getShop);
app.route("/", updateShop);

export default app;
