import * as cheerio from "cheerio";
import type { ScraperResult, ScrapedProduct } from "./types.js";
import { fetchPage, makeProduct, parseDZD, cleanText, sleep } from "./utils.js";

const BASE_URL = "https://www.prixalgerie.com";

const CATEGORY_PATHS = [
  "/category/electromenagers",
  "/category/petit-electromenager",
  "/category/gros-electromenager",
  "/category/tv-audio-photo",
  "/category/maison-jardin",
  "/category/telephonie",
  "/category/informatique",
  "/category/sante-beaute",
  "/category/bebe-et-puericulture",
  "/category/mode-et-bagagerie",
  "/category/jouets-et-jeux",
  "/category/securite",
];

export async function scrapePrixAlgerie(
  maxPages = 5
): Promise<ScraperResult> {
  const start = Date.now();
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (const catPath of CATEGORY_PATHS) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url =
          page === 1
            ? `${BASE_URL}${catPath}`
            : `${BASE_URL}${catPath}?page=${page}`;
        const html = await fetchPage(url);
        if (!html) break;

        const $ = cheerio.load(html);
        let found = 0;

        // Each product is in a grid column div
        $(".col-lg-3, .col-md-4, .col-sm-6").each((_, el) => {
          const $el = $(el);
          // Product name is in h4 > a (the link with product name)
          const $link = $el.find("h4 a").first();
          let name = cleanText($link.text());
          if (!name) {
            // Fallback: first h5 with a link might be the name
            const $alt = $el.find("h3 a, a[href*='/product/']").first();
            name = cleanText($alt.text());
          }
          if (!name) return;

          const href = $link.attr("href") ?? $el.find("a[href*='/product/']").first().attr("href") ?? "";
          // Price is in a standalone h5 containing "DZD" (not inside an <a>)
          let priceText = "";
          $el.find("h5").each((_, h5) => {
            const t = $(h5).text();
            if (t.includes("DZD")) priceText = t;
          });
          if (!priceText) {
            priceText = $el.find(".price, span:contains('DZD')").first().text();
          }

          // Skip base64 placeholder images, prefer data-src for lazy-loaded
          const imgSrc = $el.find("img").first().attr("data-src") ??
            $el.find("img").first().attr("src") ?? "";
          const img = imgSrc.startsWith("data:") ? "" : imgSrc;

          const category = catPath.split("/").pop() ?? "uncategorized";

          products.push(
            makeProduct({
              source: "prixalgerie",
              sourceUrl: href.startsWith("http")
                ? href
                : `${BASE_URL}${href}`,
              name,
              price: parseDZD(priceText),
              currency: "DZD",
              category,
              imageUrl: img && !img.startsWith("http") ? `${BASE_URL}${img}` : img,
            })
          );
          found++;
        });

        if (found === 0) break;
        await sleep(1500);
      } catch (err: any) {
        errors.push(`prixalgerie${catPath}/p${page}: ${err.message}`);
      }
    }
    await sleep(1000);
  }

  return {
    source: "prixalgerie",
    url: BASE_URL,
    products,
    totalFound: products.length,
    errors,
    duration: Date.now() - start,
  };
}
