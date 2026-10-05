import { auth, requireRole } from "../../middleware/auth";
import { router } from "../../openapi";
import getProfile from "./get-profile";
import updateProfile from "./update-profile";
import getVehicle from "./get-vehicle";
import upsertVehicle from "./upsert-vehicle";

const app = router();

app.use("/*", auth, requireRole("rider"));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", getProfile);
app.route("/", updateProfile);
app.route("/", getVehicle);
app.route("/", upsertVehicle);

export default app;
