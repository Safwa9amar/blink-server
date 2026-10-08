// Store menu categories — the merchant names categories freely
// (store_products.category); the customer app filters by
// stores.menu_categories[].id == store_products.menu_category. These helpers
// keep the two in step.

/** Stable id for a category name ("Fresh Produce" → "fresh-produce"). */
export function categorySlug(name: string, fallback = "other"): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");
  return slug || fallback;
}

type MenuCategory = { id: string; title: string };
type ProductLike = { category?: string | null; menu_category?: string | null };

/**
 * Fill each product's menu_category from its category name, and make sure the
 * store's menu_categories lists every category in use (existing order first).
 */
export function normalizeStoreMenu<P extends ProductLike>(
  menu: MenuCategory[] | null | undefined,
  products: P[]
): { menu: MenuCategory[]; products: P[] } {
  const out = [...(menu ?? [])];
  const known = new Set(out.map((m) => m.id));
  const mapped = products.map((p) => {
    if (p.menu_category || !p.category) return p;
    const id = categorySlug(p.category);
    if (!known.has(id)) {
      known.add(id);
      out.push({ id, title: p.category });
    }
    return { ...p, menu_category: id };
  });
  return { menu: out, products: mapped };
}

// ─── Merchant store → marketplace storefront ─────────────────────────
// Merchants pick a free "store type" (blink store/merchant/store-creation-store
// STORE_CATEGORY_KEYS) and edit weekly `hours`; the customer marketplace
// filters by marketplace_categories.slug and shows `opening_hours` / `is_open`.
// These helpers translate one into the other at read time.

/** Merchant store type → marketplace category slug. */
const STORE_TYPE_TO_MARKETPLACE: Record<string, string> = {
  convenience: "supermarket",
  grocery: "supermarket",
  supermarket: "supermarket",
  restaurant: "restaurant",
  bakery: "pastry",
  pharmacy: "cosmetics",
  electronics: "others",
  clothing: "others",
  other: "others",
};

/** The store's slugs plus the marketplace slugs its merchant types map to. */
export function marketplaceSlugs(slugs: string[] | null | undefined): string[] {
  const out = new Set(slugs ?? []);
  for (const s of slugs ?? []) {
    const mapped = STORE_TYPE_TO_MARKETPLACE[s];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

/** Every stored slug that should match a marketplace category filter. */
export function slugsMatching(category: string): string[] {
  const out = new Set([category]);
  for (const [type, slug] of Object.entries(STORE_TYPE_TO_MARKETPLACE)) {
    if (slug === category) out.add(type);
  }
  return [...out];
}

type Shift = { open: string; close: string };
type WeekHours = Record<string, { enabled: boolean; shifts: Shift[] }>;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const STORE_TZ = "Africa/Algiers";

/** Day key + "HH:MM" for `now` in the stores' timezone. */
function localNow(now: Date): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: STORE_TZ,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { day: get("weekday").slice(0, 3).toLowerCase(), time: `${get("hour")}:${get("minute")}` };
}

/** Is `time` inside the shift? Handles shifts that run past midnight. */
const inShift = (time: string, { open, close }: Shift) =>
  open <= close ? time >= open && time < close : time >= open || time < close;

/** Today's shifts as "08:00 - 12:00, 14:00 - 22:00", or null when closed today. */
function todayLabel(hours: WeekHours, day: string): string | null {
  const today = hours[day];
  if (!today?.enabled || today.shifts.length === 0) return null;
  return today.shifts.map((s) => `${s.open} - ${s.close}`).join(", ");
}

type StoreLike = {
  category_slugs?: string[] | null;
  is_supermarket?: boolean;
  is_open?: boolean;
  opening_hours?: string | null;
  hours?: unknown;
  manual_override?: boolean;
};

/**
 * Shape a stores row for the customer marketplace: map merchant store types
 * onto marketplace slugs, and — for stores with a weekly schedule — derive
 * today's `opening_hours` and a schedule-based `is_open` (unless the merchant
 * forced open/closed with `manual_override`).
 */
export function toStorefront<S extends StoreLike>(store: S, now = new Date()): S {
  const category_slugs = marketplaceSlugs(store.category_slugs);
  const out: S = {
    ...store,
    category_slugs,
    is_supermarket: !!store.is_supermarket || category_slugs.includes("supermarket"),
  };

  const hours = store.hours as WeekHours | null | undefined;
  if (!hours || typeof hours !== "object" || Object.keys(hours).length === 0) return out;

  const { day, time } = localNow(now);
  out.opening_hours = store.opening_hours ?? todayLabel(hours, day);
  if (!store.manual_override) {
    const todayOpen = hours[day]?.enabled && hours[day].shifts.some((s) => inShift(time, s));
    // Shifts that started yesterday and run past midnight.
    const yesterday = hours[DAY_KEYS[(DAY_KEYS.indexOf(day) + 6) % 7]];
    const carryOver =
      yesterday?.enabled && yesterday.shifts.some((s) => s.open > s.close && time < s.close);
    out.is_open = !!(todayOpen || carryOver);
  }
  return out;
}
