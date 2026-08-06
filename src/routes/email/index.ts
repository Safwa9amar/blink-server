import { Hono } from "hono";
import { auth, requireStaff, type AuthEnv } from "../../middleware/auth";
import threads from "./threads";
import reply from "./reply";
import manage from "./manage";

// Customer email inbox (staff only). Inbound mail is stored by the IMAP poll
// cron (POST /cron/email-poll); these routes list/read threads and send SMTP
// replies. All writes go through the service role and the dashboard subscribes
// to Supabase Realtime for live updates. Auth + staff gate the whole router.
const app = new Hono<AuthEnv>();
app.use("/*", auth);
app.use("/*", requireStaff());

app.route("/", threads);
app.route("/", reply);
app.route("/", manage);

export default app;
