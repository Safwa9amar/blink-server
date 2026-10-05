import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import categories from "./categories";
import articles from "./articles";

// Mobile-app-facing Help Center reader. Reads the `support_categories` and
// `support_articles` tables (admin authoring stays in the dashboard, which
// writes via the service role). Served through the admin client so we can
// filter role targeting explicitly here — same approach as the news routes.
const app = router();

// Auth gates the whole reader.
app.use("/*", auth);

// Each endpoint group lives in its own file and is mounted at the router root.
app.route("/", categories);
app.route("/", articles);

export default app;
