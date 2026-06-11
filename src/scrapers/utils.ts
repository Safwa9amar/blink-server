import type { ScrapedProduct } from "./types.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseDZD(text: string): number | null {
  if (!text) return null;
  // Extract all number groups (handles "149 000 155 000 DZD" → take first price)
  const matches = text.match(/[\d][\d\s.,]*/g);
  if (!matches?.length) return null;
  // Take the first number group
  const cleaned = matches[0]
    .replace(/\s/g, "")
    .replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

export function cleanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function fetchPage(
  url: string,
  retries = 3
): Promise<string | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8,ar;q=0.7",
        },
      });
      clearTimeout(timeout);
      if (!res.ok) {
        console.warn(`[fetch] ${url} returned ${res.status}`);
        if (res.status === 429 || res.status >= 500) {
          await sleep(5000 * (i + 1));
          continue;
        }
        return null;
      }
      return await res.text();
    } catch (err: any) {
      console.warn(`[fetch] ${url} attempt ${i + 1} failed: ${err.message}`);
      await sleep(3000 * (i + 1));
    }
  }
  return null;
}

export async function fetchJson(
  url: string,
  options?: RequestInit
): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json",
        ...options?.headers,
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function makeProduct(
  partial: Partial<ScrapedProduct> & { source: string; name: string }
): ScrapedProduct {
  return {
    sourceUrl: "",
    price: null,
    currency: "DZD",
    category: "uncategorized",
    scrapedAt: new Date().toISOString(),
    ...partial,
  };
}
