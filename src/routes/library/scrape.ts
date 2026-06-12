import { Hono } from "hono";
import { scrapeAll } from "../../scrapers/index.js";
import { OUTPUT_DIR, requireCronSecret } from "./shared";

const app = new Hono();

// POST /library/scrape — trigger a scrape
app.post("/scrape", requireCronSecret, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const maxPages = body.maxPages ?? 5;
  const sources = body.sources ?? undefined; // undefined = all

  if (sources && !Array.isArray(sources)) {
    return c.json({ error: "sources must be an array of strings" }, 400);
  }

  const { results, summary, outputPath } = await scrapeAll({
    maxPages,
    sources,
    outputDir: OUTPUT_DIR,
  });

  return c.json({
    summary,
    outputPath,
    errors: results.flatMap((r) =>
      r.errors.map((e) => ({ source: r.source, error: e }))
    ),
  });
});

export default app;
