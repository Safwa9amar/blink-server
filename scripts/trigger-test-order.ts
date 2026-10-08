// scripts/trigger-test-order.ts — run with: npm run test:order [-- <lat> <lng>]
//
// Places a REAL courier order as the DEV customer (dev.customer@blink.dev, see
// seed-dev-users.ts) through the public API — exactly what the customer app's
// "Request courier" does — so an online rider (e.g. dev.rider@blink.dev) gets
// it as an incoming request within a few seconds.
//
// The pickup defaults to central Algiers; pass the rider's area as
// `<lat> <lng>` if they're elsewhere (offers only reach riders within 15 km).
// API_URL defaults to the local server (http://localhost:$PORT).
import "dotenv/config";

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const EMAIL = "dev.customer@blink.dev";
const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";

const [latArg, lngArg] = process.argv.slice(2).map(Number);
const lat = Number.isFinite(latArg) ? latArg : 36.7631; // Sidi M'Hamed, Algiers
const lng = Number.isFinite(lngArg) ? lngArg : 3.0506;

async function main() {
  // Password sign-in via GoTrue's REST endpoint (supabase-js would need `ws` on Node < 22).
  const authRes = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: process.env.SUPABASE_ANON_KEY! },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const session = (await authRes.json()) as { access_token?: string; error_description?: string; msg?: string };
  if (!authRes.ok || !session.access_token) {
    throw new Error(`Sign-in as ${EMAIL} failed: ${session.error_description ?? session.msg ?? authRes.status}`);
  }

  // ~2.5 km drop-off to the south-east of the pickup.
  const body = {
    store_name: "Courier",
    type: "courier",
    items: [{ name: "Test parcel: pickup → drop-off", quantity: 1, unit_price: 0 }],
    subtotal: 0,
    delivery_fee: 350,
    service_fee: 0,
    pickup_address: "Test pickup — Sidi M'Hamed, Alger",
    destination_address: "Test drop-off — Belouizdad, Alger",
    pickup_lat: lat,
    pickup_lng: lng,
    destination_lat: lat - 0.015,
    destination_lng: lng + 0.02,
    vehicle_type: "motorcycle",
  };

  const res = await fetch(`${API_URL}/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`POST ${API_URL}/orders → ${res.status}: ${JSON.stringify(json)}`);
  console.log(`✅ Order ${json.order.id} (${json.order.status}) placed as ${EMAIL} at ${lat}, ${lng}`);
  console.log("   An online rider within 15 km gets it as an incoming request in ~8s (valid for 20 min).");
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
