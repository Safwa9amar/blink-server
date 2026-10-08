// scripts/trigger-test-checkout.ts — run with:
//   npm run test:checkout [-- <lat> <lng>] [-- --accept | --drive]
//
// Places a REAL 2-store checkout as the DEV customer (dev.customer@blink.dev, see
// seed-dev-users.ts) through the public API. It does exactly what the customer
// app's multi-store checkout does: one `merchant` order per store, all sharing
// one `checkout_id`. This lets the one-rider bundle flow be tested end to end.
//
//   (no flag)  only place the checkout. Accept it from the merchant app(s), or
//              wait 10 min and hit POST /cron/bundle-timeouts.
//   --accept   also accept both orders as dev.merchant@blink.dev (the stores
//              must be theirs; run npm run seed:dev-merchant first).
//   --drive    --accept, then claim the bundle as dev.rider@blink.dev and drive
//              it stop by stop to delivery through /riders/jobs. Prints the trip
//              summary. The dev rider must have no current trip.
//
// The stores are the first two active stores with coordinates, the dev
// merchant's first. The drop-off defaults to the midpoint between them; pass
// `<lat> <lng>` to move it. API_URL defaults to the local server.
//
// ⚠ Writes to the shared Supabase project: it creates real orders, and --drive
// completes a real trip for dev.rider@blink.dev.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../src/lib/supabase";

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";
const CUSTOMER = "dev.customer@blink.dev";
const MERCHANT = "dev.merchant@blink.dev";
const RIDER = "dev.rider@blink.dev";

const args = process.argv.slice(2);
const drive = args.includes("--drive");
const accept = drive || args.includes("--accept");
const [latArg, lngArg] = args.filter((a) => !a.startsWith("--")).map(Number);

type Store = {
  id: string;
  name: string;
  location: string | null;
  latitude: number;
  longitude: number;
  delivery_fee: number | null;
  owner_id: string | null;
};

/** Password sign-in via GoTrue's REST endpoint (same as trigger-test-order.ts). */
async function signIn(email: string) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY! },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const session = (await res.json()) as { access_token?: string; error_description?: string; msg?: string };
  if (!res.ok || !session.access_token) {
    throw new Error(`Sign-in as ${email} failed: ${session.error_description ?? session.msg ?? res.status}`);
  }
  return session.access_token;
}

/** An authed JSON call to the API. Throws with the server's error on a non-2xx. */
async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Two active stores with coordinates, the dev merchant's first. */
async function pickStores(): Promise<Store[]> {
  const [{ data: merchant }, { data: stores, error }] = await Promise.all([
    supabaseAdmin.from("users").select("id").eq("email", MERCHANT).maybeSingle(),
    supabaseAdmin
      .from("stores")
      .select("id, name, location, latitude, longitude, delivery_fee, owner_id")
      .eq("status", "active")
      .not("latitude", "is", null)
      .not("longitude", "is", null)
      .order("created_at", { ascending: true })
      .limit(50),
  ]);
  if (error) throw new Error(`Couldn't list stores: ${error.message}`);
  const mine = (s: Store) => Number(!!merchant && s.owner_id === merchant.id);
  const ranked = [...((stores ?? []) as Store[])].sort((a, b) => mine(b) - mine(a));
  if (ranked.length < 2) {
    const found = ranked.length ? `only 1 (${ranked[0].name})` : "none";
    throw new Error(
      `A checkout needs 2 stores with status 'active' AND latitude/longitude set; found ${found}. ` +
        "Run npm run seed:dev-merchant, or set coordinates on an active store." +
        (accept ? ` --accept / --drive also need both stores to be owned by ${MERCHANT}.` : "")
    );
  }
  if (accept) {
    if (!merchant) {
      throw new Error(`--accept / --drive need the ${MERCHANT} user — run npm run seed:dev-users first.`);
    }
    const notMine = ranked.slice(0, 2).filter((s) => !mine(s));
    if (notMine.length) {
      throw new Error(
        `--accept / --drive need 2 active stores with coordinates owned by ${MERCHANT}; ` +
          `not theirs: ${notMine.map((s) => s.name).join(", ")}. Run npm run seed:dev-merchant.`
      );
    }
  }
  return ranked.slice(0, 2);
}

/** One sellable product from the store, or else a placeholder line. */
async function pickItem(storeId: string) {
  const { data } = await supabaseAdmin
    .from("store_products")
    .select("title, price")
    .eq("store_id", storeId)
    .eq("is_available", true)
    .eq("review_status", "approved")
    .gt("stock", 0)
    .gt("price", 0)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data
    ? { name: data.title as string, unit_price: Number(data.price) }
    : { name: "Test item", unit_price: 500 };
}

async function main() {
  const stores = await pickStores();
  const lat = Number.isFinite(latArg) ? latArg : (stores[0].latitude + stores[1].latitude) / 2;
  const lng = Number.isFinite(lngArg) ? lngArg : (stores[0].longitude + stores[1].longitude) / 2;
  const checkoutId = randomUUID();
  const customer = await signIn(CUSTOMER);

  const orders: { id: string; store: Store }[] = [];
  for (const store of stores) {
    const item = await pickItem(store.id);
    const { order } = await api(customer, "POST", "/orders", {
      store_name: store.name,
      type: "merchant",
      store_id: store.id,
      checkout_id: checkoutId,
      items: [{ name: item.name, quantity: 1, unit_price: item.unit_price }],
      subtotal: item.unit_price,
      delivery_fee: Number(store.delivery_fee ?? 0),
      service_fee: 0,
      pickup_address: store.location ?? store.name,
      pickup_lat: store.latitude,
      pickup_lng: store.longitude,
      destination_address: "Test drop-off — Alger",
      destination_lat: lat,
      destination_lng: lng,
    });
    orders.push({ id: order.id, store });
    console.log(`✅ ${store.name}: order ${order.id} (${order.status} / ${order.merchant_status})`);
  }
  console.log(`   checkout_id ${checkoutId} — drop-off at ${lat.toFixed(4)}, ${lng.toFixed(4)}`);

  if (!accept) {
    console.log("   Next: accept both orders in the merchant app (or wait 10 min and POST /cron/bundle-timeouts).");
    console.log("   An online rider within 15 km of a store then gets ONE offer with 2 pickups.");
    return;
  }

  const merchant = await signIn(MERCHANT);
  for (const o of orders) {
    await api(merchant, "PATCH", `/merchant/orders/${o.id}`, { action: "accept" });
    console.log(`✅ accepted as ${MERCHANT}: ${o.store.name}`);
  }
  if (!drive) {
    console.log("   The checkout is now ONE rider offer with 2 pickups.");
    return;
  }

  // Any member id resolves to the bundle. Use the second order, not the lead, to prove it.
  const rider = await signIn(RIDER);
  let { job } = await api(rider, "POST", `/riders/jobs/${orders[1].id}/accept`);
  console.log(`✅ ${RIDER} claimed job ${job.display_id}: ${job.stops.length} stops, fare ${job.fare} DA`);
  for (const stop of job.stops as { order_id: string; store_name: string }[]) {
    await api(rider, "POST", `/riders/jobs/${job.id}/advance`, { step: "arrived", order_id: stop.order_id });
    ({ job } = await api(rider, "POST", `/riders/jobs/${job.id}/advance`, {
      step: "picked_up",
      order_id: stop.order_id,
    }));
    console.log(`   picked up at ${stop.store_name}`);
  }
  const { summary } = await api(rider, "POST", `/riders/jobs/${job.id}/advance`, { step: "delivered" });
  console.log(
    `✅ delivered — trip ${summary?.display_id}: fare ${summary?.total_fare} DA, net ${summary?.net_payout} DA`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("❌", e.message);
    process.exit(1);
  });
