import { scrapeAll } from "./index.js";

async function main() {
  const source = process.argv[2] || "prixalgerie";
  const maxPages = parseInt(process.argv[3] || "1", 10);

  console.log(`Testing scraper: ${source} (maxPages=${maxPages})\n`);

  const { results, summary } = await scrapeAll({
    maxPages,
    sources: [source],
    outputDir: "./data/library",
  });

  console.log("\n--- Summary ---");
  console.log(JSON.stringify(summary, null, 2));

  if (results[0]?.products.length > 0) {
    console.log("\n--- Sample products (first 3) ---");
    for (const p of results[0].products.slice(0, 3)) {
      console.log(JSON.stringify(p, null, 2));
    }
  }

  if (results[0]?.errors.length) {
    console.log("\n--- Errors ---");
    for (const e of results[0].errors) {
      console.log(e);
    }
  }
}

main().catch(console.error);
