import { Hono } from "hono";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import settings from "./settings";
import models from "./models";

// Admin-only AI / support-bot configuration endpoints. The dashboard WRITES
// ai_settings directly via its admin client, so this router is read-only here:
//   GET /ai/settings — the current singleton config (latest row, or defaults).
//   GET /ai/models   — model ids from a provider (best-effort; [] on error).
// Gated by auth + requireStaff (console/ERP operators only).
const app = new Hono<AuthEnv>();

app.use("/*", auth);
app.use("/*", requireStaff());

app.route("/", settings);
app.route("/", models);

export default app;
