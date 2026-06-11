import cron from "node-cron";
import { scrapeAll } from "./index.js";
import { join } from "path";

const OUTPUT_DIR = join(process.cwd(), "data", "library");

export function startLibraryCron() {
  // Daily at 3:00 AM
  cron.schedule("0 3 * * *", async () => {
    console.log("[cron] Starting daily library scrape...");
    try {
      const { summary, outputPath } = await scrapeAll({
        maxPages: 10,
        outputDir: OUTPUT_DIR,
      });
      console.log(
        `[cron] Daily scrape complete: ${summary.totalProducts} products, saved to ${outputPath}`
      );
    } catch (err: any) {
      console.error(`[cron] Daily scrape failed: ${err.message}`);
    }
  });

  // Weekly deep scrape on Sundays at 2:00 AM
  cron.schedule("0 2 * * 0", async () => {
    console.log("[cron] Starting weekly deep scrape...");
    try {
      const { summary, outputPath } = await scrapeAll({
        maxPages: 25,
        outputDir: OUTPUT_DIR,
      });
      console.log(
        `[cron] Weekly scrape complete: ${summary.totalProducts} products, saved to ${outputPath}`
      );
    } catch (err: any) {
      console.error(`[cron] Weekly scrape failed: ${err.message}`);
    }
  });

  console.log("[cron] Library scraper scheduled: daily @3am, weekly deep @Sun 2am");
}
