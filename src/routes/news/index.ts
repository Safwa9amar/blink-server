import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import list from "./list";
import detail from "./detail";
import click from "./click";

// Mobile-app-facing Blink News feed. Reads the `news` table (admin authoring
// stays in the dashboard, which writes via the service role). Served through the
// admin client so we can filter explicitly here rather than relying on the
// `news_select_published` RLS policy — same approach as the other app routes.
const app = router();

// Auth gates the whole feed.
app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", list);
app.route("/", detail);
app.route("/", click);

export default app;
