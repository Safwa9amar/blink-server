import { Hono } from "hono";
import { auth, type AuthEnv } from "../../middleware/auth";
import conversations from "./conversations";
import send from "./send";
import escalate from "./escalate";
import staff from "./staff";

// Support live chat. All writes happen here (service role); the app & dashboard
// subscribe to Supabase Realtime for live updates. Auth gates the whole router.
const app = new Hono<AuthEnv>();
app.use("/*", auth);

app.route("/", conversations);
app.route("/", send);
app.route("/", escalate);
app.route("/", staff);

export default app;
