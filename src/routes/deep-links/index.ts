import { Hono } from "hono";
import type { AuthEnv } from "../../middleware/auth";
import resolve from "./resolve";
import list from "./list";
import detail from "./detail";
import create from "./create";
import update from "./update";
import del from "./delete";

// Deep link management. The static route CATALOG stays in the app's
// deeplinks.json; this manages the dynamic, persisted links built from it —
// resolve-by-slug (public) + CRUD (authoring). Reads/writes go through the
// admin client; the `deep_links_select_active` RLS still scopes anon resolves.
const app = new Hono<AuthEnv>();

// Each endpoint lives in its own file and is mounted at the router root.
// `/resolve/:slug` is PUBLIC and carries no auth; the CRUD endpoints apply
// `auth` inline (per-endpoint) so resolving a link works before login.
app.route("/", resolve);
app.route("/", list);
app.route("/", detail);
app.route("/", create);
app.route("/", update);
app.route("/", del);

export default app;
