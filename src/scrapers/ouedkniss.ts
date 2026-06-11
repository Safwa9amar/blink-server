import type { ScraperResult, ScrapedProduct } from "./types.js";
import { fetchJson, makeProduct, sleep } from "./utils.js";

const GRAPHQL_URL = "https://api.ouedkniss.com/graphql";

const SEARCH_QUERY = `
  query SearchQuery($q: String, $categorySlug: String, $count: Int, $page: Int) {
    search(q: $q, filter: { categorySlug: $categorySlug, count: $count, page: $page }) {
      announcements {
        data {
          id
          title
          slug
          description
          price
          priceType
          priceUnit
          oldPrice
          category {
            name
            slug
          }
          defaultMedia {
            mediaUrl
          }
          cities {
            name
          }
          store {
            name
          }
          hasDelivery
          isFromStore
          createdAt
        }
        paginatorInfo {
          lastPage
          total
        }
      }
    }
  }
`;

const CATEGORIES = [
  "telephones",
  "informatique",
  "electromenager",
  "vetements",
  "vehicules",
  "immobilier",
  "beaute-bien-etre",
  "sports-loisirs",
  "maison-jardin",
  "alimentation",
  "bebe-enfant",
];

export async function scrapeOuedkniss(
  maxPages = 5
): Promise<ScraperResult> {
  const start = Date.now();
  const products: ScrapedProduct[] = [];
  const errors: string[] = [];

  for (const category of CATEGORIES) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const data = await fetchJson(GRAPHQL_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://www.ouedkniss.com",
            Referer: "https://www.ouedkniss.com/",
          },
          body: JSON.stringify({
            query: SEARCH_QUERY,
            variables: {
              categorySlug: category,
              count: 40,
              page,
            },
          }),
        });

        const announcements =
          data?.data?.search?.announcements?.data;
        if (!announcements?.length) break;

        for (const item of announcements) {
          products.push(
            makeProduct({
              source: "ouedkniss",
              sourceUrl: `https://www.ouedkniss.com/${item.slug}-d${item.id}`,
              name: item.title,
              price: item.price ?? null,
              originalPrice: item.oldPrice ?? null,
              currency: "DZD",
              category: item.category?.name ?? category,
              description: item.description ?? undefined,
              imageUrl: item.defaultMedia?.mediaUrl ?? undefined,
              seller: item.store?.name ?? undefined,
              location: item.cities?.[0]?.name ?? undefined,
              availability: item.hasDelivery ? "delivery" : "pickup",
            })
          );
        }

        const lastPage =
          data?.data?.search?.announcements?.paginatorInfo?.lastPage ?? 1;
        if (page >= lastPage) break;

        await sleep(1500);
      } catch (err: any) {
        errors.push(`ouedkniss/${category}/p${page}: ${err.message}`);
      }
    }
    await sleep(2000);
  }

  return {
    source: "ouedkniss",
    url: "https://www.ouedkniss.com",
    products,
    totalFound: products.length,
    errors,
    duration: Date.now() - start,
  };
}
