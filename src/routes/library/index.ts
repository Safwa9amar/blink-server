import { Hono } from "hono";
import sources from "./sources";
import scrape from "./scrape";
import scrapeSource from "./scrape-source";

const app = new Hono();

// Each endpoint lives in its own file and is mounted at the router root.
app.route("/", sources);
app.route("/", scrape);
app.route("/", scrapeSource);

export default app;
