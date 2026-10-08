// scripts/seed-dev-merchant.ts — run with: npm run seed:dev-merchant
//
// Fills the DEV merchant account (dev.merchant@blink.dev, see seed-dev-users.ts)
// with realistic test data so every merchant screen has something to show:
//   • 3 stores (2 active — one primary — and 1 under review), with hours/docs;
//   • products per store (library-linked when the Blink Library has published
//     items, plus manual ones — some pending review / with price suggestions);
//   • packs (active, under review, inactive);
//   • ~45 days of orders from dev.customer@blink.dev — delivered (many rated),
//     active ones waiting for the merchant, canceled and declined;
//   • one completed dues payment.
// Idempotent: re-running deletes the dev merchant's stores (cascading products
// and packs), their orders and dues payments, then recreates everything.
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

const MERCHANT_EMAIL = "dev.merchant@blink.dev";
const CUSTOMER_EMAIL = "dev.customer@blink.dev";
const RIDER_EMAIL = "dev.rider@blink.dev";

// Deterministic PRNG so re-runs produce the same shape of data.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

const DAYS = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
const hours = (open: string, close: string, closedFriday = true) =>
  Object.fromEntries(
    DAYS.map((d) => [d, { enabled: !(closedFriday && d === "fri"), shifts: [{ open, close }] }])
  );

const IMG = (id: string) => `https://images.unsplash.com/${id}?w=600&q=80`;

const STORES = [
  {
    name: "Blink Mart — Bab Ezzouar",
    description: "Neighbourhood supermarket: groceries, drinks and daily essentials.",
    phone: "0550123456",
    whatsapp: "0550123456",
    email: "babezzouar@blinkmart.dz",
    image: IMG("photo-1604754742629-3e5728249d73"),
    location: "Cité USTHB, Bab Ezzouar",
    city: "Bab Ezzouar",
    wilaya: "Alger",
    latitude: 36.7213,
    longitude: 3.1826,
    category_slugs: ["supermarket"],
    status: "active",
    is_open: true,
    is_primary: true,
    delivery_fee: 150,
    min_order: 500,
    delivery_time: "25-35 min",
    hours: hours("08:00", "22:00"),
    created_at: new Date(Date.now() - 2.3 * 365 * 864e5).toISOString(),
  },
  {
    name: "Blink Mart — Hydra",
    description: "Fresh produce, dairy and bakery in the heart of Hydra.",
    phone: "0550987654",
    whatsapp: null,
    email: "hydra@blinkmart.dz",
    image: IMG("photo-1578916171728-46686eac8d58"),
    location: "Rue des Frères Daoud, Hydra",
    city: "Hydra",
    wilaya: "Alger",
    latitude: 36.7417,
    longitude: 3.0397,
    category_slugs: ["grocery"],
    status: "active",
    is_open: true,
    is_primary: false,
    delivery_fee: 200,
    min_order: 800,
    delivery_time: "30-40 min",
    hours: hours("09:00", "21:00", false),
    created_at: new Date(Date.now() - 1.2 * 365 * 864e5).toISOString(),
  },
  {
    name: "Blink Bakery — Kouba",
    description: "Traditional breads and pastries, baked every morning.",
    phone: "0550332211",
    whatsapp: "0550332211",
    email: null,
    image: IMG("photo-1509440159596-0249088772ff"),
    location: "Boulevard Mohamed V, Kouba",
    city: "Kouba",
    wilaya: "Alger",
    latitude: 36.7266,
    longitude: 3.0858,
    category_slugs: ["bakery"],
    status: "under_review",
    is_open: false,
    is_primary: false,
    delivery_fee: 150,
    min_order: 300,
    delivery_time: "20-30 min",
    hours: hours("06:00", "20:00"),
    created_at: new Date(Date.now() - 3 * 864e5).toISOString(),
  },
];

type ManualProduct = {
  title: string;
  brand: string;
  category: string;
  unit: string;
  price: number;
  stock: number;
  photo: string;
  review_status?: "approved" | "pending" | "rejected";
  suggested?: { price: number; status: "pending" | "accepted" | "rejected" };
  /** Bab Ezzouar sells it above the Blink reference (pricing suggestions). */
  markup?: number;
  is_available?: boolean;
};

const GROCERY: ManualProduct[] = [
  { title: "Coca-Cola 1L", brand: "Coca-Cola", category: "Drinks", unit: "1L Bottle", price: 120, stock: 340, photo: IMG("photo-1629203851122-3726ecdf080e") },
  { title: "Hamoud Boualem 1L", brand: "Hamoud Boualem", category: "Drinks", unit: "1L Bottle", price: 110, stock: 210, photo: IMG("photo-1554866585-cd94860890b7") },
  { title: "Jus Rouiba Orange 1L", brand: "Rouiba", category: "Drinks", unit: "1L", price: 180, stock: 95, photo: IMG("photo-1600271886742-f049cd451bba"), suggested: { price: 170, status: "accepted" } },
  { title: "Lait Candia 1L", brand: "Candia", category: "Dairy", unit: "1L Carton", price: 90, stock: 156, photo: IMG("photo-1563636619-e9143da7973b") },
  { title: "Yaourt Soummam (x4)", brand: "Soummam", category: "Dairy", unit: "4 x 110g", price: 140, stock: 60, photo: IMG("photo-1488477181946-6428a0291777") },
  { title: "La Vache Qui Rit 16p", brand: "Bel", category: "Dairy", unit: "16 portions", price: 390, stock: 44, photo: IMG("photo-1486297678162-eb2a19b0a32d") },
  { title: "Huile Elio 5L", brand: "Cevital", category: "Food", unit: "5L", price: 980, stock: 18, photo: IMG("photo-1474979266404-7eaacbcd87c5"), suggested: { price: 1250, status: "pending" } },
  { title: "Semoule Extra 1kg", brand: "Sim", category: "Food", unit: "1kg", price: 150, stock: 120, photo: IMG("photo-1586201375761-83865001e31c") },
  { title: "Pâtes Spaghetti 500g", brand: "Sim", category: "Food", unit: "500g", price: 95, stock: 200, photo: IMG("photo-1551462147-ff29053bfc14"), markup: 1.25 },
  { title: "Biscuits Bimo Choco", brand: "Bimo", category: "Snacks", unit: "pack", price: 60, stock: 300, photo: IMG("photo-1558961363-fa8fdf82db35") },
  { title: "Chips Mahboul 150g", brand: "Mahboul", category: "Snacks", unit: "150g", price: 130, stock: 0, photo: IMG("photo-1566478989037-eec170784d0b"), is_available: false },
  { title: "Liquide Vaisselle Isis", brand: "Henkel", category: "Household", unit: "1.25L", price: 260, stock: 35, photo: IMG("photo-1585421514738-01798e348b17"), markup: 1.2 },
  { title: "Crème Maison 250g", brand: "", category: "Fresh", unit: "250g", price: 200, stock: 20, photo: "", review_status: "pending" },
  { title: "Miel de Montagne 500g", brand: "Rucher Kabyle", category: "Food", unit: "500g", price: 2200, stock: 8, photo: IMG("photo-1587049352846-4a222e784d38"), review_status: "rejected" },
];

const BAKERY: ManualProduct[] = [
  { title: "Pain Tradition", brand: "", category: "Food", unit: "piece", price: 30, stock: 150, photo: IMG("photo-1509440159596-0249088772ff") },
  { title: "Croissant au Beurre", brand: "", category: "Food", unit: "piece", price: 60, stock: 80, photo: IMG("photo-1555507036-ab1f4038808a") },
  { title: "Msemen", brand: "", category: "Food", unit: "piece", price: 50, stock: 60, photo: IMG("photo-1601050690597-df0568f70950") },
  { title: "Baklawa (6 pcs)", brand: "", category: "Snacks", unit: "box", price: 900, stock: 15, photo: IMG("photo-1519676867240-f03562e64548"), review_status: "pending" },
];

async function userId(email: string): Promise<string> {
  const { data, error } = await supabaseAdmin.from("users").select("id").eq("email", email).single();
  if (error || !data) throw new Error(`${email} not found — run npm run seed:dev-users first`);
  return data.id;
}

async function must<T>(p: PromiseLike<{ data: T; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

async function main() {
  const merchantId = await userId(MERCHANT_EMAIL);
  const customerId = await userId(CUSTOMER_EMAIL);

  // ── Reset ──────────────────────────────────────────────────────────
  const old = await must(supabaseAdmin.from("stores").select("id").eq("owner_id", merchantId), "list stores");
  const oldIds = (old ?? []).map((s: { id: string }) => s.id);
  if (oldIds.length) {
    await must(supabaseAdmin.from("orders").delete().in("store_id", oldIds), "delete orders");
    await must(supabaseAdmin.from("stores").delete().in("id", oldIds), "delete stores");
  }
  await must(supabaseAdmin.from("merchant_dues_payments").delete().eq("merchant_id", merchantId), "delete dues");
  await must(supabaseAdmin.from("merchant_ai_messages").delete().eq("merchant_id", merchantId), "delete ai messages");
  await must(supabaseAdmin.from("merchant_suggestions").delete().eq("merchant_id", merchantId), "delete suggestions");

  // ── Stores ─────────────────────────────────────────────────────────
  const stores = await must(
    supabaseAdmin
      .from("stores")
      .insert(
        STORES.map((s) => ({
          ...s,
          owner_id: merchantId,
          is_supermarket: s.category_slugs.includes("supermarket"),
          documents: {
            commercial_register_front_url: null,
            commercial_register_back_url: null,
            nif: "000016001234567",
            nis: "000116012345678",
            additional_docs: [],
          },
        }))
      )
      .select("id, name"),
    "insert stores"
  );
  const [mart, hydra, bakery] = stores as { id: string; name: string }[];
  console.log(`✓ ${stores.length} stores`);

  // ── Products ───────────────────────────────────────────────────────
  const { data: library } = await supabaseAdmin
    .from("library_products")
    .select("id, name_en, name_fr, brand, barcode, category, unit, photos, description_en")
    .eq("status", "published")
    .limit(6);

  const productRows = (storeId: string, list: ManualProduct[]) =>
    list.map((p, i) => ({
      store_id: storeId,
      title: p.title,
      brand: p.brand,
      category: p.category,
      unit: p.unit,
      price:
        p.suggested?.status === "accepted"
          ? p.suggested.price
          : storeId === mart.id && p.markup
            ? Math.round((p.price * p.markup) / 5) * 5
            : p.price,
      blink_price: p.price,
      stock: p.stock,
      photos: p.photo ? [p.photo] : [],
      image: p.photo,
      barcode: p.brand ? `613${String(1000000000 + i * 7919).slice(0, 10)}` : "",
      review_status: p.review_status ?? "approved",
      is_available: p.is_available ?? true,
      suggested_price: p.suggested?.price ?? null,
      suggestion_status: p.suggested?.status ?? null,
      library_product_id: null,
      description: null,
      sort_order: i,
    }));

  const libraryRows = (storeId: string) =>
    (library ?? []).map((l, i) => ({
      store_id: storeId,
      title: l.name_en || l.name_fr,
      description: l.description_en || null,
      brand: l.brand,
      barcode: l.barcode,
      category: l.category,
      unit: l.unit || null,
      photos: l.photos ?? [],
      image: l.photos?.[0] ?? "",
      library_product_id: l.id,
      price: 100 + i * 45,
      blink_price: 100 + i * 45,
      stock: int(10, 120),
      review_status: "approved",
      is_available: true,
      suggested_price: null,
      suggestion_status: null,
      sort_order: 100 + i,
    }));

  const products = await must(
    supabaseAdmin
      .from("store_products")
      .insert([
        ...productRows(mart.id, GROCERY),
        ...libraryRows(mart.id),
        ...productRows(hydra.id, GROCERY.slice(0, 10)),
        ...productRows(bakery.id, BAKERY),
      ])
      .select("id, store_id, title, price, review_status, is_available"),
    "insert products"
  );
  console.log(`✓ ${products.length} products (${library?.length ?? 0} library-linked)`);

  const sellable = (storeId: string) =>
    (products as any[]).filter(
      (p) => p.store_id === storeId && p.review_status === "approved" && p.is_available
    );

  // ── Packs ──────────────────────────────────────────────────────────
  const by = (storeId: string, title: string) =>
    (products as any[]).find((p) => p.store_id === storeId && p.title === title)!;
  const item = (p: any, quantity: number, promo?: [number, number]) => ({
    product_id: p.id,
    quantity,
    qty_promo_enabled: !!promo,
    buy_qty: promo?.[0] ?? 2,
    get_qty: promo?.[1] ?? 1,
  });
  const packs = [
    {
      store_id: mart.id,
      name: "Weekend Family Pack",
      description: "Drinks, snacks and dairy for the whole family.",
      image: IMG("photo-1542838132-92c53300491e"),
      items: [item(by(mart.id, "Coca-Cola 1L"), 2), item(by(mart.id, "Biscuits Bimo Choco"), 3, [2, 1]), item(by(mart.id, "Lait Candia 1L"), 2)],
      discount_enabled: true,
      discount_percent: 15,
      free_delivery: false,
      status: "active",
    },
    {
      store_id: mart.id,
      name: "Breakfast Essentials",
      description: "Milk, yogurt and cheese to start the day.",
      image: IMG("photo-1533089860892-a7c6f0a88666"),
      items: [item(by(mart.id, "Lait Candia 1L"), 1), item(by(mart.id, "Yaourt Soummam (x4)"), 1), item(by(mart.id, "La Vache Qui Rit 16p"), 1)],
      discount_enabled: false,
      discount_percent: 0,
      free_delivery: false,
      status: "active",
    },
    {
      store_id: mart.id,
      name: "Couscous Night",
      description: "Semoule, oil and a cold drink.",
      image: null,
      items: [item(by(mart.id, "Semoule Extra 1kg"), 2), item(by(mart.id, "Huile Elio 5L"), 1), item(by(mart.id, "Hamoud Boualem 1L"), 2)],
      discount_enabled: true,
      discount_percent: 10,
      free_delivery: true,
      status: "under_review",
    },
    {
      store_id: hydra.id,
      name: "Snack Box",
      description: null,
      image: null,
      items: [item(by(hydra.id, "Biscuits Bimo Choco"), 4, [3, 1]), item(by(hydra.id, "Coca-Cola 1L"), 2)],
      discount_enabled: true,
      discount_percent: 20,
      free_delivery: false,
      status: "inactive",
    },
  ];
  await must(supabaseAdmin.from("store_packs").insert(packs), "insert packs");
  console.log(`✓ ${packs.length} packs`);

  // Pack "unit price" as sold to customers (sum − discount), for order items.
  const priceOf = (id: string) => Number((products as any[]).find((p) => p.id === id)?.price ?? 0);
  const packPrice = (p: (typeof packs)[number]) => {
    const sum = p.items.reduce((t, it) => t + priceOf(it.product_id) * it.quantity, 0);
    return Math.round(sum * (1 - (p.discount_enabled ? p.discount_percent / 100 : 0)));
  };

  // ── Orders ─────────────────────────────────────────────────────────
  const orders: Record<string, unknown>[] = [];
  const now = Date.now();
  const riderId = await userId(RIDER_EMAIL);

  // ── Store drivers (Manage Riders) ──────────────────────────────────
  const drivers = await must(
    supabaseAdmin
      .from("store_drivers")
      .insert([
        { store_id: mart.id, kind: "external", rider_user_id: null, full_name: "Reda Mebarki", phone: "+213555448892", vehicle_type: "motorbike", plate_number: "16-10492-04", notes: "Full-time lunch & dinner shift", status: "active" },
        { store_id: mart.id, kind: "external", rider_user_id: null, full_name: "Yacine Toumi", phone: "+213555771203", vehicle_type: "motorbike", plate_number: "16-31877-09", notes: "Evenings only", status: "active" },
        { store_id: mart.id, kind: "external", rider_user_id: null, full_name: "Bilel Khelil", phone: "+213555901122", vehicle_type: "bicycle", plate_number: null, notes: null, status: "inactive" },
        { store_id: mart.id, kind: "blink", rider_user_id: riderId, full_name: "Dev Rider", phone: "0550000002", vehicle_type: null, plate_number: null, notes: null, status: "active" },
        { store_id: hydra.id, kind: "external", rider_user_id: null, full_name: "Karim Hadj", phone: "+213555345678", vehicle_type: "car", plate_number: "16-22841-12", notes: null, status: "active" },
      ])
      .select("id, store_id, full_name"),
    "insert drivers"
  );
  const reda = (drivers as any[]).find((d) => d.full_name === "Reda Mebarki")!;
  console.log(`✓ ${drivers.length} store drivers (Dev Rider is on Bab Ezzouar's team)`);

  // Dev rider: available, a few hundred metres from the main store.
  await supabaseAdmin
    .from("rider_profiles")
    .update({ is_available: true, latitude: 36.7245, longitude: 3.1791, location_updated_at: new Date().toISOString() })
    .eq("user_id", riderId);

  const addresses = ["Cité 1200 Logts, Bab Ezzouar", "Rue Didouche Mourad, Alger Centre", "Les Pins, Hydra", "Cité Garidi, Kouba"];
  const reviews = ["Fast and well packed!", "Everything fresh.", "A bit late but fine.", "Missing one item.", "Great service."];

  const makeOrder = (
    store: { id: string; name: string },
    createdAt: Date,
    status: string,
    merchantStatus: string | null,
    withPack: boolean,
    extra: Record<string, unknown> = {}
  ) => {
    const pool = sellable(store.id);
    const n = int(1, 4);
    const items = Array.from({ length: n }, () => {
      const p = pick(pool);
      return { name: p.title, quantity: int(1, 3), unit_price: Number(p.price) };
    });
    if (withPack) {
      const pack = packs.find((p) => p.store_id === store.id && p.status === "active");
      if (pack) items.push({ name: pack.name, quantity: 1, unit_price: packPrice(pack) });
    }
    const subtotal = items.reduce((t, it) => t + it.quantity * it.unit_price, 0);
    const delivery_fee = store.id === hydra.id ? 200 : 150;
    const service_fee = 50;
    const delivered = status === "delivered";
    const rating = delivered && rand() < 0.6 ? (rand() < 0.75 ? int(4, 5) : int(1, 3)) : null;
    const t = createdAt.getTime();
    const at = (min: number) => new Date(t + min * 60e3).toISOString();
    const accepted = merchantStatus && merchantStatus !== "pending" && merchantStatus !== "rejected";
    const canceled = status === "canceled" || status === "merchant_rejected";
    const own = rand() < 0.25;
    const origin = store.id === hydra.id ? { lat: 36.7417, lng: 3.0397 } : { lat: 36.7213, lng: 3.1826 };
    const review = rating && rand() < 0.5 ? pick(reviews) : null;
    orders.push({
      customer_id: customerId,
      store_id: store.id,
      store_name: store.name,
      type: "merchant",
      status,
      merchant_status: merchantStatus,
      items,
      subtotal,
      delivery_fee,
      service_fee,
      discount: 0,
      total: subtotal + delivery_fee + service_fee,
      pickup_address: store.name,
      destination_address: pick(addresses),
      estimated_time: "30 min",
      store_rating: rating,
      store_review: review,
      // A few older reviews already answered.
      store_review_reply: review && rating && rating >= 4 && rand() < 0.4 ? "Thank you, see you soon!" : null,
      store_review_replied_at: null,
      pickup_lat: origin.lat,
      pickup_lng: origin.lng,
      destination_lat: origin.lat + (rand() - 0.5) * 0.04,
      destination_lng: origin.lng + (rand() - 0.5) * 0.04,
      accepted_at: accepted ? at(2) : null,
      prepared_at: delivered ? at(12) : null,
      rider_assigned_at: delivered ? at(14) : null,
      picked_up_at: delivered ? at(20) : null,
      delivered_at: delivered ? at(int(30, 45)) : null,
      canceled_at: canceled ? at(5) : null,
      canceled_by: status === "canceled" ? "customer" : status === "merchant_rejected" ? "merchant" : null,
      merchant_reject_reason: status === "merchant_rejected" ? pick(["out_of_stock", "closing_soon", "cannot_fulfil"]) : null,
      delivery_mode: delivered ? (own && store.id === mart.id ? "own" : "blink") : null,
      store_driver_id: delivered && own && store.id === mart.id ? reda.id : null,
      rider_id: delivered && !(own && store.id === mart.id) ? riderId : null,
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
      ...extra,
    });
  };

  // History: ~45 days, busier on weekends and in the evening.
  for (let day = 45; day >= 1; day--) {
    const date = new Date(now - day * 864e5);
    const weekend = date.getDay() === 5 || date.getDay() === 6;
    for (const store of [mart, hydra]) {
      const count = int(store === mart ? 1 : 0, store === mart ? (weekend ? 5 : 3) : 2);
      for (let k = 0; k < count; k++) {
        const t = new Date(date);
        t.setHours(rand() < 0.45 ? int(18, 21) : int(8, 17), int(0, 59), 0, 0);
        const r = rand();
        if (r < 0.88) makeOrder(store, t, "delivered", "ready", rand() < 0.25);
        else if (r < 0.95) makeOrder(store, t, "canceled", "accepted", false);
        else makeOrder(store, t, "merchant_rejected", "rejected", false);
      }
    }
  }
  // Today: orders waiting for the merchant or in progress.
  const today = (h: number, m: number) => {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d.getTime() > now ? new Date(now - int(5, 40) * 60e3) : d;
  };
  const ago = (min: number) => new Date(now - min * 60e3);
  const iso = (min: number) => ago(min).toISOString();
  // Delivered earlier today.
  makeOrder(mart, today(9, 12), "delivered", "ready", true);
  // Out for delivery with a Blink rider (Dev Rider).
  makeOrder(mart, ago(45), "on_the_way", "ready", false, {
    accepted_at: iso(43), prepared_at: iso(32), rider_assigned_at: iso(30), picked_up_at: iso(20),
    delivery_mode: "blink", rider_id: riderId, store_driver_id: null,
  });
  // Waiting for pickup by the store's own driver.
  makeOrder(mart, ago(30), "pickup", "ready", false, {
    accepted_at: iso(28), prepared_at: iso(15), rider_assigned_at: iso(12),
    delivery_mode: "own", store_driver_id: reda.id, rider_id: null,
  });
  // Prepared — needs a rider.
  makeOrder(mart, ago(22), "searching", "ready", true, {
    accepted_at: iso(20), prepared_at: iso(4), rider_assigned_at: null, delivery_mode: null, store_driver_id: null, rider_id: null,
  });
  // Being prepared.
  makeOrder(mart, ago(12), "searching", "accepted", false, {
    accepted_at: iso(10), prepared_at: null, rider_assigned_at: null, delivery_mode: null, store_driver_id: null, rider_id: null,
  });
  makeOrder(hydra, ago(15), "searching", "accepted", true, {
    accepted_at: iso(13), prepared_at: null, rider_assigned_at: null, delivery_mode: null, store_driver_id: null, rider_id: null,
  });
  // Handed to a Blink shopper (merchant was too busy).
  makeOrder(mart, ago(50), "searching", "rejected", false, {
    type: "shopper", merchant_reject_reason: "too_busy", accepted_at: null,
  });
  // New — waiting for accept / reject.
  makeOrder(mart, ago(6), "processing", "pending", false);
  makeOrder(mart, ago(2), "processing", "pending", true);
  makeOrder(hydra, ago(9), "processing", "pending", false);

  for (let i = 0; i < orders.length; i += 200) {
    await must(supabaseAdmin.from("orders").insert(orders.slice(i, i + 200)), "insert orders");
  }
  console.log(`✓ ${orders.length} orders`);

  // Store rating roll-up (same as POST /orders/{id}/rate).
  for (const store of [mart, hydra]) {
    const rated = orders.filter((o) => o.store_id === store.id && o.store_rating) as any[];
    if (!rated.length) continue;
    const avg = rated.reduce((t, o) => t + o.store_rating, 0) / rated.length;
    await must(
      supabaseAdmin
        .from("stores")
        .update({ rating: Math.round(avg * 10) / 10, review_count: rated.length })
        .eq("id", store.id),
      "update rating"
    );
  }

  // ── Dues: one past payment for the main store ──────────────────────
  const martSales = (orders as any[])
    .filter((o) => o.store_id === mart.id && o.status === "delivered")
    .reduce((t, o) => t + o.subtotal, 0);
  const paid = Math.round(martSales * 0.05 * 0.6);
  await must(
    supabaseAdmin.from("merchant_dues_payments").insert({
      merchant_id: merchantId,
      store_id: mart.id,
      amount: paid,
      fees: Math.round(paid * 0.002 * 100) / 100,
      method: "baridimob",
      status: "completed",
      created_at: new Date(now - 10 * 864e5).toISOString(),
    }),
    "insert dues payment"
  );
  console.log(`✓ dues payment ${paid} DA`);

  // ── Strategy: weekly goal + one Blink AI exchange with a saved suggestion
  await must(supabaseAdmin.from("stores").update({ weekly_goal: 30000 }).eq("id", mart.id), "weekly goal");
  const suggestion = await must(
    supabaseAdmin
      .from("merchant_suggestions")
      .insert({
        merchant_id: merchantId,
        store_id: mart.id,
        source: "chat",
        kind: "bundle",
        title: "Introduce Lunch Combo bundles",
        body: "Pair a drink with a snack between 12:00 and 14:00 at 10% off to lift your quiet lunch hours.",
        data: { question: "How can I increase revenue during lunch?" },
      })
      .select("id")
      .single(),
    "insert suggestion"
  );
  await must(
    supabaseAdmin.from("merchant_ai_messages").insert([
      { merchant_id: merchantId, store_id: mart.id, role: "user", content: "How can I increase revenue during lunch?", created_at: new Date(now - 2 * 864e5).toISOString() },
      {
        merchant_id: merchantId,
        store_id: mart.id,
        role: "assistant",
        content: "Your lunch window (12:00–14:00) is quieter than evenings. A small lunch combo — a cold drink plus a snack at 10% off — usually lifts that slot without hurting margins.",
        suggestion_id: (suggestion as any).id,
        created_at: new Date(now - 2 * 864e5 + 5000).toISOString(),
      },
    ]),
    "insert ai messages"
  );
  console.log("✓ weekly goal, 1 AI chat + suggestion");
  console.log("Done — sign in as dev.merchant@blink.dev.");
}

main().catch((e) => {
  console.error("✗", e.message ?? e);
  process.exit(1);
});
