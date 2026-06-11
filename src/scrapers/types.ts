export interface ScrapedProduct {
  source: string;
  sourceUrl: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  price: number | null;
  originalPrice?: number | null;
  currency: string;
  category: string;
  subcategory?: string;
  description?: string;
  imageUrl?: string;
  images?: string[];
  brand?: string;
  seller?: string;
  availability?: string;
  location?: string;
  barcode?: string;
  ean?: string;
  sku?: string;
  tags?: string[];
  scrapedAt: string;
}

export interface ScraperResult {
  source: string;
  url: string;
  products: ScrapedProduct[];
  totalFound: number;
  errors: string[];
  duration: number;
}

export interface ScraperConfig {
  name: string;
  enabled: boolean;
  baseUrl: string;
  rateLimit: number; // ms between requests
  maxPages: number;
}
