import * as cheerio from "cheerio";
import type { ScraperResult, ScrapedProduct } from "./types.js";
import { fetchPage, makeProduct, parseDZD, cleanText, sleep } from "./utils.js";

const BASE_URL = "https://aliments.tidjaria.com";

const CATEGORY_IDS = [
  { id: "3-produits-frais", name: "Produits frais" },
  { id: "15-fruits-et-legumes", name: "Fruits et legumes" },
  { id: "21-viandes-poissons", name: "Viandes et poissons" },
  { id: "25-produits-laitiers", name: "Produits laitiers" },
  { id: "30-produits-surgeles", name: "Produits surgeles" },
  { id: "37-boissons", name: "Boissons" },
  { id: "42-epiceries-et-salee", name: "Epicerie salee" },
  { id: "47-epiceries-sucree", name: "Epicerie sucree" },
  { id: "53-pain-produits-de-la-patesserie", name: "Pain et patisserie" },
];

export async function scrapeTidjaria(
  maxPages = 5
): Promise<ScraperResult> {
  const start = Date.now();
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (const cat of CATEGORY_IDS) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url =
          page === 1
            ? `${BASE_URL}/${cat.id}`
            : `${BASE_URL}/${cat.id}?page=${page}`;
        const html = await fetchPage(url);
        if (!html) break;

        const $ = cheerio.load(html);
        let found = 0;

        $(
          ".product-item, .product-miniature, [class*='product']"
        ).each((_, el) => {
          const $el = $(el);
          const name = cleanText(
            $el.find("a.product-name, .product-title a, h3 a").first().text()
          ) || cleanText($el.find("h3, h4, .product-title").first().text());
          if (!name || name.length < 3) return;
          // Skip generic section headers
          if (/^(new products|nos produits|produits?)$/i.test(name)) return;

          const priceText = $el
            .find(".price, .product-price, [class*='price']")
            .first()
            .text();
          const href = $el.find("a").first().attr("href") ?? "";
          const img =
            $el.find("img").first().attr("src") ??
            $el.find("img").first().attr("data-src") ??
            "";
          const seller = cleanText(
            $el.find(".seller, .store-name, [class*='seller']").first().text()
          ) || undefined;

          products.push(
            makeProduct({
              source: "tidjaria",
              sourceUrl: href.startsWith("http")
                ? href
                : `${BASE_URL}${href}`,
              name,
              price: parseDZD(priceText),
              currency: "DZD",
              category: cat.name,
              imageUrl: img.startsWith("http") ? img : `${BASE_URL}${img}`,
              seller,
            })
          );
          found++;
        });

        if (found === 0) break;
        await sleep(1500);
      } catch (err: any) {
        errors.push(`tidjaria/${cat.id}/p${page}: ${err.message}`);
      }
    }
    await sleep(1000);
  }

  return {
    source: "tidjaria",
    url: BASE_URL,
    products,
    totalFound: products.length,
    errors,
    duration: Date.now() - start,
  };
}
