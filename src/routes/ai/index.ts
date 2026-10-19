import { Hono } from "hono";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import settings from "./settings";
import models from "./models";
import kb from "./kb";

// Admin-only AI / support-bot configuration endpoints. The dashboard WRITES
// ai_settings directly via its admin client, so this router is read-only here:
//   GET /ai/settings — the current singleton config (latest row, or defaults).
//   GET /ai/models   — model ids from a provider (best-effort; [] on error).
//   /ai/kb/{status,reindex,search}, GET /ai/embedding-models — support-bot RAG.
// Gated by auth + requireStaff (console/ERP operators only).
const app = new Hono<AuthEnv>();

app.use("/*", auth);
app.use("/*", requireStaff());

app.route("/", settings);
app.route("/", models);
app.route("/", kb);

export default app;
