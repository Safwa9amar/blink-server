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

// ─── Paged product filters (PostgREST `or` groups) ──────────────────

/** A PostgREST filter value in double quotes — safe with , . : ( ) " \ inside. */
function pgQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Products in menu category `id`: rows tagged with it, plus untagged rows
 * whose category name slugs to it (what normalizeStoreMenu does at read time).
 * `names` are the category names in use in the store.
 */
export function menuCategoryFilter(id: string, names: (string | null)[]): string {
  const tagged = `menu_category.eq.${pgQuote(id)}`;
  const matching = [...new Set(names)].filter(
    (n): n is string => !!n && categorySlug(n) === id
  );
  if (matching.length === 0) return `or(${tagged})`;
  return `or(${tagged},and(menu_category.is.null,category.in.(${matching.map(pgQuote).join(",")})))`;
}

/** Products with `q` in the title, description or unit (case-insensitive). */
export function productSearchFilter(q: string): string {
  const like = pgQuote(`%${q}%`);
  return `or(title.ilike.${like},description.ilike.${like},unit.ilike.${like})`;
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

/** Day key, "HH:MM" and the calendar date of `now` in the stores' timezone. */
function localNow(now: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: STORE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    day: get("weekday").slice(0, 3).toLowerCase(),
    time: `${get("hour")}:${get("minute")}`,
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
  };
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

/** The weekly schedule, or null when the store has none. */
function scheduleOf(hours: unknown): WeekHours | null {
  if (!hours || typeof hours !== "object" || Object.keys(hours).length === 0) return null;
  return hours as WeekHours;
}

/** When the schedule next opens strictly after `now` (ISO), or null if it never does. */
function nextOpenAt(hours: WeekHours, now: Date): string | null {
  const { day, time, y, m, d } = localNow(now);
  // The stores' UTC offset at `now` (Algeria: +1, no DST), minute precision.
  const [hh, mm] = time.split(":").map(Number);
  const offset = Date.UTC(y, m - 1, d, hh, mm) - Math.floor(now.getTime() / 60e3) * 60e3;
  const start = DAY_KEYS.indexOf(day);
  // Up to 7 days ahead — today's weekday again for a shift earlier than now.
  for (let i = 0; i <= 7; i++) {
    const entry = hours[DAY_KEYS[(start + i) % 7]];
    if (!entry?.enabled) continue;
    const opens = entry.shifts
      .map((s) => s.open)
      .filter((open) => i > 0 || open > time)
      .sort();
    if (opens.length === 0) continue;
    const [oh, om] = opens[0].split(":").map(Number);
    return new Date(Date.UTC(y, m - 1, d + i, oh, om) - offset).toISOString();
  }
  return null;
}

type StoreLike = {
  category_slugs?: string[] | null;
  is_supermarket?: boolean;
  is_open?: boolean;
  opening_hours?: string | null;
  hours?: unknown;
  manual_override?: boolean;
};

export type StoreOpenState = {
  is_open: boolean;
  /** Next scheduled opening while closed; null when open or closed indefinitely. */
  next_open_at: string | null;
};

/**
 * Is the store taking orders at `now`? With a weekly schedule it follows the
 * schedule (shifts past midnight included), unless the merchant forced
 * open/closed with `manual_override` — then, like stores without hours, the
 * stored `is_open` decides.
 */
export function storeOpenState(store: StoreLike, now = new Date()): StoreOpenState {
  const hours = scheduleOf(store.hours);
  if (!hours || store.manual_override) {
    return { is_open: store.is_open ?? true, next_open_at: null };
  }
  const { day, time } = localNow(now);
  const todayOpen = hours[day]?.enabled && hours[day].shifts.some((s) => inShift(time, s));
  // Shifts that started yesterday and run past midnight.
  const yesterday = hours[DAY_KEYS[(DAY_KEYS.indexOf(day) + 6) % 7]];
  const carryOver =
    yesterday?.enabled && yesterday.shifts.some((s) => s.open > s.close && time < s.close);
  const is_open = !!(todayOpen || carryOver);
  return { is_open, next_open_at: is_open ? null : nextOpenAt(hours, now) };
}

// ─── Privacy: staff/merchant-only store columns ──────────────────────

/**
 * `stores` columns only the merchant and Blink staff may see: the legal
 * documents (commercial register scans, NIF, NIS…), the per-document staff
 * verdicts (with reviewer ids), the internal review note and the merchant's
 * sales goal. Never send them to customers or riders.
 */
export const PRIVATE_STORE_FIELDS = [
  "documents",
  "document_review",
  "review_note",
  "weekly_goal",
] as const;
export type PrivateStoreField = (typeof PRIVATE_STORE_FIELDS)[number];

/** A copy of a stores row without PRIVATE_STORE_FIELDS (every other column kept). */
export function stripPrivateStoreFields<S extends object>(row: S): Omit<S, PrivateStoreField> {
  const out = { ...row } as Record<string, unknown>;
  for (const key of PRIVATE_STORE_FIELDS) delete out[key];
  return out as Omit<S, PrivateStoreField>;
}

/**
 * Shape a stores row for the customer marketplace: map merchant store types
 * onto marketplace slugs, derive today's `opening_hours` from the weekly
 * schedule, and the live `is_open` / `next_open_at` (see storeOpenState).
 * Staff/merchant-only columns are dropped (stripPrivateStoreFields).
 */
export function toStorefront<S extends StoreLike>(
  store: S,
  now = new Date()
): Omit<S, PrivateStoreField> & StoreOpenState & { is_supermarket: boolean } {
  const category_slugs = marketplaceSlugs(store.category_slugs);
  const hours = scheduleOf(store.hours);
  return {
    ...stripPrivateStoreFields(store),
    category_slugs,
    is_supermarket: !!store.is_supermarket || category_slugs.includes("supermarket"),
    // From the full row: the schedule and the merchant's manual override.
    ...storeOpenState(store, now),
    ...(hours ? { opening_hours: store.opening_hours ?? todayLabel(hours, localNow(now).day) } : {}),
  };
}
