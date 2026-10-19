import { auth } from "../../middleware/auth";
import { router } from "../../openapi";
import categories from "./categories";
import list from "./list";
import detail from "./detail";
import products from "./products";
import productsLookup from "./products-lookup";
import packs from "./packs";
import branchSuggestion from "./branch-suggestion";

const app = router();

// Catalog browsing — any signed-in user (customers shop; merchants preview).
app.use("/*", auth);

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", categories);
app.route("/", list);
app.route("/", detail);
app.route("/", products);
app.route("/", productsLookup);
app.route("/", packs);
app.route("/", branchSuggestion);

export default app;
