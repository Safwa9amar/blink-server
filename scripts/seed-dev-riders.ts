// scripts/seed-dev-riders.ts — run with: npm run seed:dev-riders [-- --live | --offline]
//
// Idempotent seed for 20 DEV riders spread across Algiers, so ride and courier
// requests there find free riders ("N riders nearby", pickup ETA, offers).
// Each rider gets:
//   • a Supabase auth user dev.riderNN@blink.dev (password = DEV_USERS_PASSWORD,
//     default BlinkDev#2026), email pre-confirmed — sign in with it on a device
//     to accept the offers;
//   • a public.users row (role rider, wilaya Alger) + rider_profiles row that is
//     ONLINE (is_available) at a fixed Algiers position with a vehicle type;
//   • a vehicles row (brand, plate, colour — shown on the customer's rider card).
// Mix: 16 motorcycles (rides + courier) and 4 bicycles (courier only); 6 are
// female, for the ride "Female rider only" toggle. A rider's gender is locked
// once set (ride migration), so never change one here — add a new rider instead.
//
// `--offline` takes all 20 off the map again (is_available = false).
// `--live` keeps running after the seed: every minute each rider's position is
// re-sent (a slow ~150 m loop around their spot), like the rider app does while
// online. The request map only draws riders updated in the last 10 minutes
// (NEARBY_MAP_FRESH_MS), so without it they vanish from the map 10 min after a
// seed (still counted as "nearby"). A rider whose position changes under us (a
// device signed in as them) or who goes offline is left alone from then on.
// Ctrl-C to stop.
// Targets the Supabase project of the loaded env (.env = online). For arch:
//   npx tsx --env-file=.env.arch.local scripts/seed-dev-riders.ts
import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { ensureRoleProfile } from "../src/routes/auth/shared";

const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";
const OFFLINE = process.argv.includes("--offline");
const LIVE = process.argv.includes("--live") && !OFFLINE;
const LIVE_TICK_MS = 60_000;
/** Radius (m) and period (ticks) of the loop a live rider drives around their spot. */
const LIVE_LOOP_M = 150;
const LIVE_LOOP_TICKS = 12;

type Vehicle = "motorcycle" | "bicycle";
type DevRider = {
  first_name: string;
  last_name: string;
  gender: "male" | "female";
  vehicle: Vehicle;
  area: string;
  lat: number;
  lng: number;
};

// All within ~12 km of Alger Centre (the offer radius is 15 km, OFFER_RADIUS_KM).
const RIDERS: DevRider[] = [
  { first_name: "Yacine", last_name: "Benali", gender: "male", vehicle: "motorcycle", area: "Alger Centre", lat: 36.7753, lng: 3.0588 },
  { first_name: "Amine", last_name: "Khelifi", gender: "male", vehicle: "motorcycle", area: "Sidi M'Hamed", lat: 36.7631, lng: 3.0506 },
  { first_name: "Sofiane", last_name: "Bouzid", gender: "male", vehicle: "motorcycle", area: "Bab El Oued", lat: 36.7906, lng: 3.0503 },
  { first_name: "Nadia", last_name: "Meziane", gender: "female", vehicle: "motorcycle", area: "Didouche Mourad", lat: 36.7689, lng: 3.0522 },
  { first_name: "Karim", last_name: "Hadj", gender: "male", vehicle: "motorcycle", area: "Belouizdad", lat: 36.7525, lng: 3.0700 },
  { first_name: "Riad", last_name: "Saadi", gender: "male", vehicle: "motorcycle", area: "El Madania", lat: 36.7458, lng: 3.0624 },
  { first_name: "Lina", last_name: "Cherif", gender: "female", vehicle: "motorcycle", area: "Hydra", lat: 36.7406, lng: 3.0283 },
  { first_name: "Mehdi", last_name: "Ouali", gender: "male", vehicle: "motorcycle", area: "El Biar", lat: 36.7667, lng: 3.0333 },
  { first_name: "Walid", last_name: "Rahmani", gender: "male", vehicle: "motorcycle", area: "Hussein Dey", lat: 36.7411, lng: 3.0975 },
  { first_name: "Sara", last_name: "Djebbar", gender: "female", vehicle: "motorcycle", area: "Kouba", lat: 36.7289, lng: 3.0822 },
  { first_name: "Hichem", last_name: "Mansouri", gender: "male", vehicle: "motorcycle", area: "Bir Mourad Raïs", lat: 36.7350, lng: 3.0500 },
  { first_name: "Imene", last_name: "Belkacem", gender: "female", vehicle: "motorcycle", area: "Ben Aknoun", lat: 36.7578, lng: 3.0092 },
  { first_name: "Fares", last_name: "Zerrouki", gender: "male", vehicle: "motorcycle", area: "Bologhine", lat: 36.8031, lng: 3.0375 },
  { first_name: "Islam", last_name: "Bensaid", gender: "male", vehicle: "motorcycle", area: "Mohammadia", lat: 36.7350, lng: 3.1450 },
  { first_name: "Amel", last_name: "Taleb", gender: "female", vehicle: "motorcycle", area: "Dely Ibrahim", lat: 36.7550, lng: 2.9850 },
  { first_name: "Nassim", last_name: "Guerfi", gender: "male", vehicle: "motorcycle", area: "Bab Ezzouar", lat: 36.7200, lng: 3.1850 },
  { first_name: "Adel", last_name: "Messaoudi", gender: "male", vehicle: "bicycle", area: "Place des Martyrs", lat: 36.7856, lng: 3.0611 },
  { first_name: "Rania", last_name: "Hamidi", gender: "female", vehicle: "bicycle", area: "Grande Poste", lat: 36.7727, lng: 3.0597 },
  { first_name: "Bilal", last_name: "Amrani", gender: "male", vehicle: "bicycle", area: "Telemly", lat: 36.7650, lng: 3.0450 },
  { first_name: "Zakaria", last_name: "Lounis", gender: "male", vehicle: "bicycle", area: "Le Ruisseau", lat: 36.7480, lng: 3.0780 },
];

const MOTOS = ["Honda PCX 125", "Yamaha NMAX 125", "SYM Jet 14", "Peugeot Kisbee", "VMS Virago"];
const BIKES = ["Decathlon Elops 520", "Btwin Riverside 500"];
const COLORS = ["Black", "White", "Red", "Blue", "Grey"];

const pad = (n: number) => String(n).padStart(2, "0");

/** Find an auth user by email (admin API has no direct lookup — page through). */
async function findAuthUserId(email: string): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 1000) return undefined;
  }
}

async function seed(r: DevRider, i: number): Promise<string> {
  const n = pad(i + 1);
  const email = `dev.rider${n}@blink.dev`;
  const metadata = { given_name: r.first_name, family_name: r.last_name, dev_user: true };

  let id = await findAuthUserId(email);
  if (id) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    });
    if (error) throw error;
    id = data.user.id;
  }

  const { error: rowError } = await supabaseAdmin.from("users").upsert(
    {
      id,
      email,
      role: "rider",
      signup_role: "rider",
      first_name: r.first_name,
      last_name: r.last_name,
      phone_number: `05501001${n}`,
      gender: r.gender,
      birthday: `199${i % 10}-0${(i % 9) + 1}-1${i % 10}`,
      wilaya: "Alger",
      wilaya_code: "16",
    },
    { onConflict: "id" },
  );
  if (rowError) throw rowError;

  await ensureRoleProfile(id, "rider");
  const { error: profileError } = await supabaseAdmin
    .from("rider_profiles")
    .update({
      vehicle_type: r.vehicle,
      is_available: !OFFLINE,
      latitude: r.lat,
      longitude: r.lng,
      location_updated_at: new Date().toISOString(),
    })
    .eq("user_id", id);
  if (profileError) throw profileError;

  const models = r.vehicle === "motorcycle" ? MOTOS : BIKES;
  const { error: vehicleError } = await supabaseAdmin.from("vehicles").upsert(
    {
      user_id: id,
      brand: models[i % models.length].split(" ")[0],
      model: models[i % models.length].split(" ").slice(1).join(" "),
      license_plate: r.vehicle === "motorcycle" ? `${10000 + i * 137}-1${i % 10}-16` : `BK-${n}`,
      year: String(2019 + (i % 6)),
      color: COLORS[i % COLORS.length],
      category: "standard",
    },
    { onConflict: "user_id" },
  );
  if (vehicleError) throw vehicleError;

  const state = OFFLINE ? "offline" : "online ";
  console.log(`✓ ${email}  ${state} ${r.vehicle.padEnd(10)} ${r.gender.padEnd(6)} ${r.area}`);
  return id;
}

type LiveRider = {
  id: string;
  email: string;
  rider: DevRider;
  /** Where the loop starts, so riders don't all move in step. */
  phase: number;
  /** The position this script last wrote; anything else means a device took over. */
  last: { lat: number; lng: number };
  released: boolean;
};

/** Position at tick `t` on a LIVE_LOOP_M circle around the rider's spot. */
function loopPosition(l: LiveRider, t: number) {
  const angle = ((t + l.phase) / LIVE_LOOP_TICKS) * 2 * Math.PI;
  const mPerDegLat = 111_320;
  return {
    lat: l.rider.lat + (LIVE_LOOP_M * Math.cos(angle)) / mPerDegLat,
    lng: l.rider.lng + (LIVE_LOOP_M * Math.sin(angle)) / (mPerDegLat * Math.cos((l.rider.lat * Math.PI) / 180)),
  };
}

const samePosition = (a: { lat: number; lng: number }, lat: unknown, lng: unknown) =>
  typeof lat === "number" && typeof lng === "number" && Math.abs(lat - a.lat) < 1e-7 && Math.abs(lng - a.lng) < 1e-7;

async function liveTick(live: LiveRider[], t: number): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .select("user_id, latitude, longitude, is_available")
    .in("user_id", live.map((l) => l.id));
  if (error) {
    console.error(`tick ${t}: ${error.message}`);
    return;
  }
  const current = new Map((data ?? []).map((p) => [p.user_id as string, p]));
  let refreshed = 0;
  await Promise.all(
    live
      .filter((l) => !l.released)
      .map(async (l) => {
        const p = current.get(l.id);
        if (!p?.is_available || !samePosition(l.last, p.latitude, p.longitude)) {
          l.released = true;
          console.log(`  ${l.email} left alone from now on (${p?.is_available ? "position sent by a device" : "offline"})`);
          return;
        }
        const pos = loopPosition(l, t);
        const { error: updateError } = await supabaseAdmin
          .from("rider_profiles")
          .update({ latitude: pos.lat, longitude: pos.lng, location_updated_at: new Date().toISOString() })
          .eq("user_id", l.id);
        // Retried next tick (`last` unchanged). A gateway timeout's message is a whole HTML page.
        if (updateError) return console.error(`  ${l.email}: ${updateError.message.replace(/\s+/g, " ").slice(0, 120)}`);
        l.last = pos;
        refreshed++;
      }),
  );
  console.log(`↻ ${new Date().toLocaleTimeString()}  ${refreshed} riders refreshed`);
}

const ids: string[] = [];
for (const [i, r] of RIDERS.entries()) ids.push(await seed(r, i));
console.log(`\n${RIDERS.length} riders ${OFFLINE ? "offline" : "online in Algiers"}. Password: ${PASSWORD}`);

if (LIVE) {
  console.log(`\nLive: re-sending positions every ${LIVE_TICK_MS / 1000}s. Ctrl-C to stop.`);
  const live: LiveRider[] = RIDERS.map((rider, i) => ({
    id: ids[i],
    email: `dev.rider${pad(i + 1)}@blink.dev`,
    rider,
    phase: i,
    last: { lat: rider.lat, lng: rider.lng },
    released: false,
  }));
  for (let t = 1; live.some((l) => !l.released); t++) {
    await new Promise((done) => setTimeout(done, LIVE_TICK_MS));
    await liveTick(live, t);
  }
  console.log("Every rider was taken over or went offline — stopping.");
}
