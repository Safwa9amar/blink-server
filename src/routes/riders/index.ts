import { auth, requireRole } from "../../middleware/auth";
import { router } from "../../openapi";
import getProfile from "./get-profile";
import updateProfile from "./update-profile";
import getVehicle from "./get-vehicle";
import upsertVehicle from "./upsert-vehicle";
import location from "./location";
import storeInvitations from "./store-invitations";
import jobs from "./jobs";
import wallet from "./wallet";
import perks from "./perks";

const app = router();

app.use("/*", auth, requireRole("rider"));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", getProfile);
app.route("/", updateProfile);
app.route("/", getVehicle);
app.route("/", upsertVehicle);
app.route("/", location);
app.route("/", storeInvitations);
app.route("/", jobs);
app.route("/", wallet);
app.route("/", perks);

export default app;
