import { auth, requireRole } from "../../middleware/auth";
import { requireVerifiedPartner, AGENT_ONBOARDING } from "../../lib/verified-account";
import { router } from "../../openapi";
import nearby from "./nearby";
import profile from "./profile";
import getShop from "./get-shop";
import updateShop from "./update-shop";
import shops from "./shops";
import uploads from "./uploads";
import dues from "./dues";
import perks from "./perks";
import requiredActions from "./required-actions";
import adminReview from "./admin-review";

const app = router();

app.use("/*", auth);
// /nearby is the riders' agent locator and /admin/* carries its own
// requireStaff guard; everything else is the agent app.
app.use("/*", async (c, next) => {
  if (c.req.path.endsWith("/agents/nearby") || c.req.path.includes("/agents/admin/")) return next();
  return requireRole("agent")(c, next);
});
app.use("/*", requireVerifiedPartner({ prefix: "/agents", allow: AGENT_ONBOARDING, skip: "/admin/" }));

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", nearby);
app.route("/", profile);
app.route("/", getShop);
app.route("/", updateShop);
app.route("/", shops);
app.route("/", uploads);
app.route("/", dues);
app.route("/", perks);
app.route("/", requiredActions);
app.route("/", adminReview);

export default app;
