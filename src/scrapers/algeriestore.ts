import * as cheerio from "cheerio";
import type { ScraperResult, ScrapedProduct } from "./types.js";
import { fetchPage, makeProduct, parseDZD, cleanText, sleep } from "./utils.js";

const BASE_URL = "https://algeriestore.com";

export async function scrapeAlgerieStore(
  maxPages = 10
): Promise<ScraperResult> {
  const start = Date.now();
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url =
        page === 1
          ? `${BASE_URL}/products`
          : `${BASE_URL}/products?page=${page}`;
      const html = await fetchPage(url);
      if (!html) break;

      const $ = cheerio.load(html);
      let found = 0;

      // Products use data-product-id attribute on various container elements
      $("[data-product-id]").each((_, el) => {
        const $el = $(el);
        const name = cleanText($el.attr("data-product-name") ?? "");
        if (!name) return;

        const priceAttr = $el.attr("data-product-price") ?? "";
        const price = parseFloat(priceAttr) || parseDZD($el.find(".price").first().text());
        const href =
          $el.find("a[href*='/products/']").first().attr("href") ??
          $el.find("a").first().attr("href") ?? "";
        const img =
          $el.find("img").first().attr("data-src") ??
          $el.find("img").first().attr("src") ?? "";
        const brand = $el.attr("data-product-brand") ?? undefined;
        const categories = $el.attr("data-product-categories") ?? "";

        products.push(
          makeProduct({
            source: "algeriestore",
            sourceUrl: href.startsWith("http")
              ? href
              : `${BASE_URL}${href}`,
            name,
            price,
            currency: "DZD",
            category: categories.split(",")[0]?.trim() || "uncategorized",
            imageUrl: img.startsWith("http") ? img : img ? `${BASE_URL}${img}` : "",
            brand,
          })
        );
        found++;
      });

      if (found === 0) break;
      await sleep(1500);
    } catch (err: any) {
      errors.push(`algeriestore/p${page}: ${err.message}`);
    }
  }

  return {
    source: "algeriestore",
    url: BASE_URL,
    products,
    totalFound: products.length,
    errors,
    duration: Date.now() - start,
  };
}
