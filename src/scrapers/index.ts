import { scrapeOuedkniss } from "./ouedkniss.js";
import { scrapePrixAlgerie } from "./prixalgerie.js";
// AlgerieStore disabled — requires headless browser (JS-rendered product grid)
// import { scrapeAlgerieStore } from "./algeriestore.js";
import { scrapeTidjaria } from "./tidjaria.js";
import {
  scrapeWooCommerceSite,
  getWooSiteNames,
} from "./woocommerce.js";
import type { ScraperResult, ScrapedProduct } from "./types.js";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

export type { ScraperResult, ScrapedProduct };

interface ScrapeAllOptions {
  maxPages?: number;
  sources?: string[];
  outputDir?: string;
}

const ALL_SOURCES = [
  "ouedkniss",
  "prixalgerie",
  "tidjaria",
  ...getWooSiteNames(),
];

export function getAvailableSources(): string[] {
  return ALL_SOURCES;
}

async function runScraper(
  source: string,
  maxPages: number
): Promise<ScraperResult> {
  switch (source) {
    case "ouedkniss":
      return scrapeOuedkniss(maxPages);
    case "prixalgerie":
      return scrapePrixAlgerie(maxPages);
    case "tidjaria":
      return scrapeTidjaria(maxPages);
    default:
      if (getWooSiteNames().includes(source)) {
        return scrapeWooCommerceSite(source, maxPages);
      }
      return {
        source,
        url: "",
        products: [],
        totalFound: 0,
        errors: [`Unknown source: ${source}`],
        duration: 0,
      };
  }
}

export async function scrapeAll(
  options: ScrapeAllOptions = {}
): Promise<{
  results: ScraperResult[];
  summary: {
    totalProducts: number;
    bySource: Record<string, number>;
    totalErrors: number;
    totalDuration: number;
  };
  outputPath?: string;
}> {
  const { maxPages = 5, sources, outputDir } = options;
  const activeSources = sources ?? ALL_SOURCES;

  console.log(
    `[scraper] Starting scrape of ${activeSources.length} sources (maxPages=${maxPages})`
  );

  const results: ScraperResult[] = [];

  // Run scrapers sequentially to be respectful of rate limits
  for (const source of activeSources) {
    console.log(`[scraper] Scraping ${source}...`);
    try {
      const result = await runScraper(source, maxPages);
      results.push(result);
      console.log(
        `[scraper] ${source}: ${result.totalFound} products in ${result.duration}ms (${result.errors.length} errors)`
      );
    } catch (err: any) {
      results.push({
        source,
        url: "",
        products: [],
        totalFound: 0,
        errors: [err.message],
        duration: 0,
      });
      console.error(`[scraper] ${source} failed: ${err.message}`);
    }
  }

  // Deduplicate by source+name+price
  const seen = new Set<string>();
  const allProducts = results.flatMap((r) => r.products).filter((p) => {
    const key = `${p.source}|${p.name}|${p.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const bySource: Record<string, number> = {};
  for (const r of results) {
    bySource[r.source] = r.totalFound;
  }

  const summary = {
    totalProducts: allProducts.length,
    bySource,
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
    totalDuration: results.reduce((sum, r) => sum + r.duration, 0),
  };

  let outputPath: string | undefined;

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = join(outputDir, `products-${timestamp}.json`);

    await writeFile(
      filePath,
      JSON.stringify(
        {
          scrapedAt: new Date().toISOString(),
          summary,
          products: allProducts,
        },
        null,
        2
      )
    );

    outputPath = filePath;
    console.log(`[scraper] Saved ${allProducts.length} products to ${filePath}`);
  }

  return { results, summary, outputPath };
}
