// scripts/trigger-test-ride.ts — run with: npm run test:ride [-- <lat> <lng>] [--female]
//
// Requests a REAL ride as the DEV customer (dev.customer@blink.dev, see
// seed-dev-users.ts) through the public API — exactly what the customer app's
// "Request ride" does: POST /ride/quote, then POST /ride/requests — so an
// online MOTORCYCLE rider (e.g. dev.rider@blink.dev) gets it as an incoming
// request within a few seconds. `--female` asks for a female rider only.
//
// The pickup defaults to central Algiers; pass the rider's area as
// `<lat> <lng>` if they're elsewhere (offers only reach riders within 15 km).
// API_URL defaults to the local server (http://localhost:$PORT).
import "dotenv/config";

const API_URL = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const EMAIL = "dev.customer@blink.dev";
const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";

const args = process.argv.slice(2);
const femaleRiderOnly = args.includes("--female");
const [latArg, lngArg] = args.filter((a) => a !== "--female").map(Number);
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
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new Error(`POST ${API_URL}${path} → ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };

  // ~2.5 km destination to the south-east of the pickup.
  const pickup = { label: "Test pickup", address: "Sidi M'Hamed, Alger", lat, lng, note: "Test ride — main entrance" };
  const destination = { label: "Test destination", address: "Belouizdad, Alger", lat: lat - 0.015, lng: lng + 0.02 };

  const quote = await post("/ride/quote", {
    pickup: { lat: pickup.lat, lng: pickup.lng },
    destination: { lat: destination.lat, lng: destination.lng },
    female_rider_only: femaleRiderOnly,
  });
  const moto = quote.options[0];
  console.log(
    `💬 Quote: ${quote.distance_km} km · ${moto.total} DZD · ${moto.duration_minutes} min · ` +
      `${moto.nearby_riders} rider(s) nearby${moto.available ? "" : ` · unavailable (${moto.unavailable_reason})`}`
  );

  const { order } = await post("/ride/requests", {
    pickup,
    destination,
    passenger: null,
    vehicle_type: "motorcycle",
    female_rider_only: femaleRiderOnly,
  });
  console.log(`✅ Ride ${order.id} (${order.status}, ${order.total} DZD) requested as ${EMAIL} at ${lat}, ${lng}`);
  console.log("   An online motorcycle rider within 15 km gets it in ~8s (canceled as no_rider after 10 min).");
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
