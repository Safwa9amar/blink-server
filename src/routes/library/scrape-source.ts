import { Hono } from "hono";
import { scrapeAll, getAvailableSources } from "../../scrapers/index.js";
import { OUTPUT_DIR, requireCronSecret } from "./shared";

const app = new Hono();

app.use("/scrape/:source", requireCronSecret);

// POST /library/scrape/:source — scrape a single source
app.post("/scrape/:source", async (c) => {
  const source = c.req.param("source");
  const available = getAvailableSources();

  if (!available.includes(source)) {
    return c.json(
      { error: `Unknown source: ${source}. Available: ${available.join(", ")}` },
      400
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const maxPages = body.maxPages ?? 5;

  const { results, summary, outputPath } = await scrapeAll({
    maxPages,
    sources: [source],
    outputDir: OUTPUT_DIR,
  });

  return c.json({
    summary,
    outputPath,
    products: results[0]?.products ?? [],
    errors: results[0]?.errors ?? [],
  });
});

export default app;
