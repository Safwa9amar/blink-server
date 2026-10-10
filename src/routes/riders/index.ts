import { env } from "../../config/env";
import { auth, requireRole, requireStaff } from "../../middleware/auth";
import { requireVerifiedPartner, RIDER_ONBOARDING } from "../../lib/verified-account";
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
import uploads from "./uploads";
import documents from "./documents";
import requiredActions from "./required-actions";
import adminReview from "./admin-review";

const app = router();

app.use("/*", auth);
// /riders/admin/* is staff-only (requireStaff here, and again on the route);
// everything else is the rider app (requireRole("rider")).
app.use("/*", async (c, next) => {
  if (c.req.path.startsWith(`${env.BASE_PATH}/riders/admin/`)) return requireStaff()(c, next);
  return requireRole("rider")(c, next);
});
app.use("/*", requireVerifiedPartner({ prefix: "/riders", allow: RIDER_ONBOARDING, skip: "/admin/" }));

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
app.route("/", uploads);
app.route("/", documents);
app.route("/", requiredActions);
app.route("/", adminReview);

export default app;
