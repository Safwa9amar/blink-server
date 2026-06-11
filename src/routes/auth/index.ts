import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth";
import sendOtp from "./send-otp";
import verifyOtp from "./verify-otp";
import google from "./google";
import apple from "./apple";
import refresh from "./refresh";
import role from "./role";
import updateProfile from "./update-profile";
import profile from "./profile";
import avatar from "./avatar";
import setupPin from "./setup-pin";
import verifyPin from "./verify-pin";

const app = new Hono<AuthEnv>();

// Each endpoint lives in its own file and is mounted at the router root.
// Order matches the original declaration order (matters for route matching).
app.route("/", sendOtp);
app.route("/", verifyOtp);
app.route("/", google);
app.route("/", apple);
app.route("/", refresh);
app.route("/", role);
app.route("/", updateProfile);
app.route("/", profile);
app.route("/", avatar);
app.route("/", setupPin);
app.route("/", verifyPin);

export default app;
