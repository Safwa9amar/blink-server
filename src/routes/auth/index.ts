import { router } from "../../openapi";
import sendOtp from "./send-otp";
import verifyOtp from "./verify-otp";
import registerPhone from "./register-phone";
import emailAvailable from "./email-available";
import linkPhone from "./link-phone";
import google from "./google";
import apple from "./apple";
import refresh from "./refresh";
import role from "./role";
import partnerRoles from "./partner-roles";
import activeRole from "./active-role";
import updateProfile from "./update-profile";
import profile from "./profile";
import avatar from "./avatar";
import setupPin from "./setup-pin";
import verifyPin from "./verify-pin";
import deletionRequest from "./deletion-request";

const app = router();

// Each endpoint lives in its own file and is mounted at the router root.
// Order matches the original declaration order (matters for route matching).
app.route("/", sendOtp);
app.route("/", verifyOtp);
app.route("/", registerPhone);
app.route("/", emailAvailable);
app.route("/", linkPhone);
app.route("/", google);
app.route("/", apple);
app.route("/", refresh);
app.route("/", role);
app.route("/", partnerRoles);
app.route("/", activeRole);
app.route("/", updateProfile);
app.route("/", profile);
app.route("/", avatar);
app.route("/", setupPin);
app.route("/", verifyPin);
app.route("/", deletionRequest);

export default app;
