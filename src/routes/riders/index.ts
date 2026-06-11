import { Hono } from "hono";
import { auth, requireRole, type AuthEnv } from "../../middleware/auth";
import getProfile from "./get-profile";
import updateProfile from "./update-profile";
import getVehicle from "./get-vehicle";
import upsertVehicle from "./upsert-vehicle";

const app = new Hono<AuthEnv>();

app.use("/*", auth, requireRole("rider"));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", getProfile);
app.route("/", updateProfile);
app.route("/", getVehicle);
app.route("/", upsertVehicle);

export default app;
