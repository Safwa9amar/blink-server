import { Hono } from "hono";
import { getAvailableSources } from "../../scrapers/index.js";

const app = new Hono();

// GET /library/sources — list available scraper sources
app.get("/sources", (c) => {
  return c.json({ sources: getAvailableSources() });
});

export default app;
