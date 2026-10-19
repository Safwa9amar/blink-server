import { Hono } from "hono";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import threads from "./threads";
import chat from "./chat";
import models from "./models";

// Staff AI assistant (dashboard chat). Plain Hono, NOT in the OpenAPI spec.
//   GET  /assistant/config
//   GET  /assistant/models            (super_admin)
//   GET|POST /assistant/threads, PATCH|DELETE /assistant/threads/:id
//   GET  /assistant/threads/:id/messages
//   POST /assistant/threads/:id/chat  (SSE)
const app = new Hono<AuthEnv>();

app.use("/*", auth);
app.use("/*", requireStaff());

app.route("/", models);
app.route("/", threads);
app.route("/", chat);

export default app;
