import { scrapeAll, getAvailableSources } from "./index.js";

async function main() {
  const maxPages = parseInt(process.argv[2] || "1", 10);
  const sources = getAvailableSources();

  console.log(`Full scrape test: ${sources.length} sources (maxPages=${maxPages})`);
  console.log(`Sources: ${sources.join(", ")}\n`);

  const { results, summary, outputPath } = await scrapeAll({
    maxPages,
    outputDir: "./data/library",
  });

  console.log("\n=== FINAL SUMMARY ===");
  console.log(`Total products: ${summary.totalProducts}`);
  console.log(`Total errors: ${summary.totalErrors}`);
  console.log(`Total duration: ${(summary.totalDuration / 1000).toFixed(1)}s`);
  console.log("\nBy source:");
  for (const [source, count] of Object.entries(summary.bySource)) {
    const result = results.find((r) => r.source === source);
    const status = count > 0 ? "OK" : "EMPTY";
    console.log(`  ${status} ${source}: ${count} products (${result?.errors.length ?? 0} errors)`);
  }
  console.log(`\nOutput: ${outputPath}`);
}

main().catch(console.error);
