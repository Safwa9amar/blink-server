import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import conversations from "./conversations";
import send from "./send";
import escalate from "./escalate";
import staff from "./staff";

// Support live chat. All writes happen here (service role); the app & dashboard
// subscribe to Supabase Realtime for live updates. Auth gates the whole router.
const app = router();
app.use("/*", auth);

app.route("/", conversations);
app.route("/", send);
app.route("/", escalate);
app.route("/", staff);

export default app;
