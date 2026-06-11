import * as cheerio from "cheerio";
import type { ScraperResult, ScrapedProduct } from "./types.js";
import {
  fetchPage,
  fetchJson,
  makeProduct,
  parseDZD,
  cleanText,
  sleep,
} from "./utils.js";

interface WooSite {
  name: string;
  baseUrl: string;
  hasRestApi: boolean;
  currency: string;
}

const WOO_SITES: WooSite[] = [
  {
    name: "algeriemarket",
    baseUrl: "https://algeriemarket.com",
    hasRestApi: true,
    currency: "DZD",
  },
  {
    name: "jibhali",
    baseUrl: "https://jibhali.com",
    hasRestApi: true,
    currency: "DZD",
  },
  {
    name: "fromalgeria",
    baseUrl: "https://fromalgeria.com",
    hasRestApi: true,
    currency: "USD",
  },
  {
    name: "areejstore",
    baseUrl: "https://areej.store",
    hasRestApi: true,
    currency: "DZD",
  },
];

async function scrapeWooRest(
  site: WooSite,
  maxPages: number
): Promise<{ products: ScrapedProduct[]; errors: string[] }> {
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${site.baseUrl}/wp-json/wc/store/v1/products?page=${page}&per_page=50`;
    const data = await fetchJson(url);

    if (!data || !Array.isArray(data)) {
      // Fallback: try the public wc/store namespace
      const alt = `${site.baseUrl}/wp-json/wc/store/products?page=${page}&per_page=50`;
      const altData = await fetchJson(alt);
      if (!altData || !Array.isArray(altData)) break;
      for (const item of altData) {
        products.push(mapWooProduct(item, site));
      }
      if (altData.length < 50) break;
    } else {
      for (const item of data) {
        products.push(mapWooProduct(item, site));
      }
      if (data.length < 50) break;
    }

    await sleep(1500);
  }

  return { products, errors };
}

function mapWooProduct(item: any, site: WooSite): ScrapedProduct {
  // WC Store API returns prices in smallest currency unit based on currency_minor_unit
  const minorUnit = item.prices?.currency_minor_unit ?? 2;
  const divisor = Math.pow(10, minorUnit);
  const rawPrice = parseFloat(item.prices?.price ?? item.price ?? "0");
  const rawOriginal = parseFloat(item.prices?.regular_price ?? item.regular_price ?? "0");
  const price = rawPrice ? rawPrice / divisor : null;
  const originalPrice = rawOriginal ? rawOriginal / divisor : null;

  return makeProduct({
    source: site.name,
    sourceUrl: item.permalink ?? `${site.baseUrl}/product/${item.slug}`,
    name: cleanText(item.name ?? ""),
    price: price !== 0 ? price : null,
    originalPrice: originalPrice !== 0 ? originalPrice : null,
    currency: site.currency,
    category:
      item.categories?.[0]?.name ??
      item.category?.name ??
      "uncategorized",
    description: item.short_description
      ? cleanText(item.short_description.replace(/<[^>]*>/g, ""))
      : undefined,
    imageUrl:
      item.images?.[0]?.src ??
      item.images?.[0]?.thumbnail ??
      undefined,
    images: item.images?.map((i: any) => i.src).filter(Boolean),
    brand: item.brands?.[0]?.name ?? undefined,
    barcode: item.barcode ?? item.ean ?? item.meta_data?.find((m: any) => m.key === "_barcode" || m.key === "barcode")?.value ?? undefined,
    ean: item.ean ?? item.meta_data?.find((m: any) => m.key === "_ean" || m.key === "ean")?.value ?? undefined,
    sku: item.sku ?? undefined,
    availability: item.is_in_stock ? "in_stock" : "out_of_stock",
  });
}

async function scrapeWooHtml(
  site: WooSite,
  maxPages: number
): Promise<{ products: ScrapedProduct[]; errors: string[] }> {
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url =
      page === 1
        ? `${site.baseUrl}/shop/`
        : `${site.baseUrl}/shop/page/${page}/`;
    const html = await fetchPage(url);
    if (!html) break;

    const $ = cheerio.load(html);
    let found = 0;

    $(".product, li.product, .product-item").each((_, el) => {
      const $el = $(el);
      const name = cleanText(
        $el
          .find(
            ".woocommerce-loop-product__title, h2, h3, .product-title"
          )
          .first()
          .text()
      );
      if (!name) return;

      const priceText = $el
        .find(".price, .woocommerce-Price-amount")
        .first()
        .text();
      const href = $el.find("a").first().attr("href") ?? "";
      const img =
        $el.find("img").first().attr("src") ??
        $el.find("img").first().attr("data-src") ??
        "";

      products.push(
        makeProduct({
          source: site.name,
          sourceUrl: href.startsWith("http") ? href : `${site.baseUrl}${href}`,
          name,
          price: parseDZD(priceText),
          currency: site.currency,
          category: "uncategorized",
          imageUrl: img,
        })
      );
      found++;
    });

    if (found === 0) break;
    await sleep(1500);
  }

  return { products, errors };
}

export async function scrapeWooCommerceSite(
  siteName: string,
  maxPages = 10
): Promise<ScraperResult> {
  const site = WOO_SITES.find((s) => s.name === siteName);
  if (!site) {
    return {
      source: siteName,
      url: "",
      products: [],
      totalFound: 0,
      errors: [`Unknown WooCommerce site: ${siteName}`],
      duration: 0,
    };
  }

  const start = Date.now();

  // Try REST API first, fall back to HTML scraping
  let result = await scrapeWooRest(site, maxPages);
  if (result.products.length === 0) {
    result = await scrapeWooHtml(site, maxPages);
  }

  return {
    source: site.name,
    url: site.baseUrl,
    products: result.products,
    totalFound: result.products.length,
    errors: result.errors,
    duration: Date.now() - start,
  };
}

export function getWooSiteNames(): string[] {
  return WOO_SITES.map((s) => s.name);
}
