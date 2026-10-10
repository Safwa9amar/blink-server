// scripts/e2e-ride.ts — end-to-end API smoke test of rides (passenger moto-taxi).
//
//   npm run e2e:ride                                         # env from .env
//   npx tsx --env-file=.env.arch.local scripts/e2e-ride.ts   # the arch dev DB (server: npm run dev:arch)
//
// Flags:
//   --slow         D: the real no-show (waits 5 min at the pickup)
//   --expiry       J: the no_rider expiry (waits 10 min; a ride's created_at can't
//                  be backdated through the API). Runs alongside the others.
//   --no-coupon    never touch the dev customer's coupons (L, J)
//   --only=A,B     run only these scenarios
//   --verbose      log every HTTP call
//   --allow-cloud  run although SUPABASE_URL is a hosted *.supabase.co project
//
// Only HTTP: GoTrue password sign-in for the DEV customer and the DEV rider
// (scripts/seed-dev-users.ts), then the public API — no database access. Every
// ride it creates is canceled (or finished) before it exits, Ctrl+C included,
// and the rider's vehicle type, availability and position are put back.
// API_URL defaults to http://localhost:$PORT (3001). Exit code 1 if anything failed.
// Spec: blink/docs/superpowers/specs/2026-10-09-ride-requests-design.md
import "dotenv/config";
// Type-only: the server's own request / response schemas (erased at runtime,
// so nothing from src/ — env checks, DB clients — is loaded).
import type { z } from "@hono/zod-openapi";
import type { AuthProfileResponse } from "../src/validators/auth";
import type { rateOrderSchema, riderLocationSchema } from "../src/validators/merchant";
import type {
  createOrderSchema,
  OrderSchema,
  rateRiderSchema,
  RideDetailsSchema,
  updateOrderStatusSchema,
} from "../src/validators/orders";
import type { CouponSchema } from "../src/validators/promotions";
import type { createRideRequestSchema, RideQuoteResponse, rideQuoteSchema } from "../src/validators/ride";
import type { RiderCardSchema } from "../src/validators/rider-card";
import type {
  acceptJobSchema,
  AdvanceJobResponse,
  advanceJobSchema,
  availabilitySchema,
  cancelJobSchema,
  RiderJobSchema,
} from "../src/validators/rider-jobs";
import type { updateRiderProfileSchema } from "../src/validators/riders";

// ─── Config ──────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const SLOW = flag("slow");
const EXPIRY = flag("expiry");
const NO_COUPON = flag("no-coupon");
const VERBOSE = flag("verbose");
const ALLOW_CLOUD = flag("allow-cloud");
const ONLY = new Set(
  (args.find((a) => a.startsWith("--only="))?.slice("--only=".length) ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
);

const API_URL = (process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3001}`).replace(/\/$/, "");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PASSWORD = process.env.DEV_USERS_PASSWORD ?? "BlinkDev#2026";
const CRON_SECRET = process.env.CRON_SECRET ?? "";
const CUSTOMER_EMAIL = "dev.customer@blink.dev";
const RIDER_EMAIL = "dev.rider@blink.dev";

// ─── Server rules this test checks against (spec + src/lib/ride*.ts) ──
const RATE = { base: 200, includedKm: 3, perKm: 40, speedKmh: 28, maxKm: 40, minKm: 0.3, boardingMin: 2, step: 10 };
const ROAD_FACTOR = 1.3;
const COMMISSION_RATE = 0.15;
/** A rider may report a no-show this long after arriving (else 400 no_show_too_early). */
const NO_SHOW_WAIT_MS = 5 * 60_000;
/** An unclaimed ride is canceled (no_rider) this long after going live. */
const SEARCH_TIMEOUT_MS = 10 * 60_000;
const LIVE = ["searching", "heading_to_store", "pickup", "on_the_way"];
const CUSTOMER_CANCELABLE = ["searching", "heading_to_store", "pickup"];

// ─── Places ──────────────────────────────────────────────────────────
type Pt = { lat: number; lng: number };
type Place = Pt & { label: string; address: string };
/** Every ride this test creates is labelled so a later run can clean it up. */
const E2E = "[e2e]";
const GRANDE_POSTE: Place = { label: `${E2E} Grande Poste`, address: "Grande Poste, Alger Centre", lat: 36.7731, lng: 3.0592 };
const HYDRA: Place = { label: `${E2E} Hydra`, address: "Hydra, Alger", lat: 36.7425, lng: 3.03 };
/** > 40 road km from Grande Poste. */
const BLIDA: Place = { label: `${E2E} Blida`, address: "Blida", lat: 36.47, lng: 2.83 };
/** J's ride: > 15 km (the offer radius) from the rider parked at Grande Poste, so it is never offered meanwhile. */
const BOUMERDES: Place = { label: `${E2E} Boumerdes`, address: "Boumerdes centre", lat: 36.7569, lng: 3.4772 };
const BOUMERDES_EAST: Place = { label: `${E2E} Boumerdes est`, address: "Boumerdes", lat: 36.7445, lng: 3.456 };
const PICKUP_NOTE = `${E2E} main entrance, by the stairs`;

// ─── Expected server math (re-implemented from the spec on purpose) ──
const round1 = (n: number) => Math.round(n * 10) / 10;
function haversineKm(a: Pt, b: Pt) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const rideKm = (a: Pt, b: Pt) => round1(haversineKm(a, b) * ROAD_FACTOR);
const rideFare = (km: number) => Math.ceil((RATE.base + Math.max(0, km - RATE.includedKm) * RATE.perKm) / RATE.step) * RATE.step;
const rideDuration = (km: number) => Math.max(1, Math.round((km / RATE.speedKmh) * 60 + RATE.boardingMin));
const pickupEta = (riderKm: number) => Math.max(2, Math.round(((riderKm * ROAD_FACTOR) / RATE.speedKmh) * 60) + 1);
const KM = rideKm(GRANDE_POSTE, HYDRA);
const FARE = rideFare(KM);
const DURATION = rideDuration(KM);

// ─── Types (the server's schemas; numeric / jsonb columns pinned down) ─
type RideDetails = z.infer<typeof RideDetailsSchema>;
type RiderCard = z.infer<typeof RiderCardSchema>;
type Order = z.infer<typeof OrderSchema> & {
  id: string;
  type: string;
  status: string;
  customer_id: string;
  rider_id: string | null;
  store_name: string;
  subtotal: number;
  delivery_fee: number;
  discount: number;
  total: number;
  coupon_id: string | null;
  vehicle_type: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  destination_lat: number | null;
  destination_lng: number | null;
  accepted_at: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  canceled_at: string | null;
  canceled_by: string | null;
  cancel_reason: string | null;
  cancel_note: string | null;
  rider_rating: number | null;
  rider_tags: string[] | null;
  ride: RideDetails | null;
  rider?: RiderCard;
};
type RiderJob = z.infer<typeof RiderJobSchema>;
type Quote = z.infer<typeof RideQuoteResponse>;
type Advance = z.infer<typeof AdvanceJobResponse>;
type Coupon = z.infer<typeof CouponSchema> & {
  id: string;
  code: string;
  status: "active" | "used" | "expired";
  min_order: number | null;
  order_id: string | null;
};
type Profile = z.infer<typeof AuthProfileResponse> & {
  user: {
    id: string;
    role: string;
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
    gender: string | null;
  };
  rider_profile?: {
    vehicle_type: string | null;
    is_available: boolean | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
};
type QuoteBody = z.input<typeof rideQuoteSchema>;
type RideBody = z.input<typeof createRideRequestSchema>;
type StatusBody = z.input<typeof updateOrderStatusSchema>;
type CancelBody = Omit<StatusBody, "status">;
type RateRiderBody = z.input<typeof rateRiderSchema>;
type RateStoreBody = z.input<typeof rateOrderSchema>;
type CreateOrderBody = z.input<typeof createOrderSchema>;
type AcceptBody = z.input<typeof acceptJobSchema>;
type AdvanceBody = z.input<typeof advanceJobSchema>;
type CancelJobBody = z.input<typeof cancelJobSchema>;
type LocationBody = z.input<typeof riderLocationSchema>;
type AvailabilityBody = z.input<typeof availabilitySchema>;
type RiderProfileBody = z.input<typeof updateRiderProfileSchema>;
type Vehicle = NonNullable<RiderProfileBody["vehicle_type"]>;

// ─── HTTP ────────────────────────────────────────────────────────────
interface ErrorBody {
  error?: string;
  code?: string;
  details?: { path: string; message: string }[];
}
interface Res<T> {
  status: number;
  body: T & ErrorBody;
}
type Actor = { label: string; token: string; id: string };

async function http<T>(
  who: Actor | null,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Res<T>> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(who ? { Authorization: `Bearer ${who.token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { error: text.slice(0, 200) };
  }
  if (VERBOSE) console.log(`      ${who?.label ?? "anon"} ${method} ${path} -> ${res.status}`);
  return { status: res.status, body: (parsed ?? {}) as T & ErrorBody };
}

/** Password sign-in via GoTrue's REST endpoint (same as trigger-test-ride.ts). */
async function signIn(label: string, email: string): Promise<Actor> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY! },
    body: JSON.stringify({ email, password: PASSWORD }),
    signal: AbortSignal.timeout(30_000),
  });
  const session = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    user?: { id?: string };
    error_description?: string;
    msg?: string;
  };
  if (!res.ok || !session.access_token || !session.user?.id) {
    throw new Error(
      `sign-in as ${email} failed: ${session.error_description ?? session.msg ?? res.status} (run npm run seed:dev-users?)`
    );
  }
  return { label, token: session.access_token, id: session.user.id };
}

// ─── Assertions ──────────────────────────────────────────────────────
class Fail extends Error {}
class Skip extends Error {}

const show = (v: unknown) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v));

function errText(b: ErrorBody) {
  const msg = [b.code, b.error, ...(b.details ?? []).map((d) => `${d.path}: ${d.message}`)].filter(Boolean).join(" · ");
  // A Postgres error leaking through usually means the ride migrations aren't applied.
  return /order_type|column .*ride|enum|canceled_by_check/i.test(msg) ? `${msg} (ride migrations applied?)` : msg;
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Fail(msg);
}

function eq(actual: unknown, expected: unknown, what: string) {
  if (actual !== expected) throw new Fail(`${what}: expected ${show(expected)}, got ${show(actual)}`);
}

/** The body when the status is as expected ("4xx" = any client error), else a Fail. */
function expectStatus<T>(r: Res<T>, want: number | "4xx", what: string): T & ErrorBody {
  const ok = want === "4xx" ? r.status >= 400 && r.status < 500 : r.status === want;
  if (!ok) {
    const err = errText(r.body);
    throw new Fail(`${what}: expected HTTP ${want}, got ${r.status}${err ? ` (${err})` : ""}`);
  }
  return r.body;
}

const hasCode = (b: ErrorBody, code: string) => b.code === code || JSON.stringify(b).includes(code);

const step = (msg: string) => console.log(`    - ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(at: number, what: string) {
  while (Date.now() < at) {
    const left = at - Date.now();
    step(`${what}: ${Math.ceil(left / 1000)} s to go`);
    await sleep(Math.min(left, 60_000));
  }
}

// ─── API clients ─────────────────────────────────────────────────────
let customer: Actor;
let rider: Actor;

/** Every ride this run created and hasn't seen end yet (cleanup). */
const open = new Set<string>();
/** J's ride: left searching on purpose until J checks it. */
const parked = new Set<string>();

const C = {
  profile: () => http<Profile>(customer, "GET", "/auth/profile"),
  quote: (b: QuoteBody) => http<Quote>(customer, "POST", "/ride/quote", b),
  /** POST /ride/requests; any ride it creates is tracked, even one that should have been refused. */
  request: async (b: RideBody) => {
    const r = await http<{ order: Order }>(customer, "POST", "/ride/requests", b);
    if (r.status === 201 && r.body.order?.id) open.add(r.body.order.id);
    return r;
  },
  createOrder: async (b: unknown) => {
    const r = await http<{ order: Order }>(customer, "POST", "/orders", b);
    if (r.status === 201 && r.body.order?.id) open.add(r.body.order.id);
    return r;
  },
  order: (id: string) => http<{ order: Order }>(customer, "GET", `/orders/${id}`),
  orders: () => http<{ orders: Order[] }>(customer, "GET", "/orders?limit=50"),
  cancel: (id: string, b: CancelBody) => {
    const body: StatusBody = { status: "canceled", ...b };
    return http<{ order: Order }>(customer, "PATCH", `/orders/${id}/status`, body);
  },
  rateRider: (id: string, b: RateRiderBody) => http<{ order: Order }>(customer, "POST", `/orders/${id}/rate-rider`, b),
  rateStore: (id: string, b: RateStoreBody) => http<{ order: Order }>(customer, "POST", `/orders/${id}/rate`, b),
  coupons: () => http<{ coupons: Coupon[] }>(customer, "GET", "/coupons"),
};

const R = {
  profile: () => http<Profile>(rider, "GET", "/auth/profile"),
  setVehicle: (b: RiderProfileBody) =>
    http<{ profile: { vehicle_type: string | null } }>(rider, "PATCH", "/riders/profile", b),
  location: (b: LocationBody) => http<{ success: boolean }>(rider, "PATCH", "/riders/location", b),
  availability: (b: AvailabilityBody) => http<{ is_available: boolean }>(rider, "PATCH", "/riders/availability", b),
  offer: () => http<{ job?: RiderJob }>(rider, "GET", "/riders/jobs/offer"),
  current: () => http<{ job?: RiderJob }>(rider, "GET", "/riders/jobs/current"),
  /** request_expires_at null = taking it as an ordinary pool job, like the app. */
  accept: (id: string, b: AcceptBody = { request_expires_at: null }) =>
    http<{ job: RiderJob }>(rider, "POST", `/riders/jobs/${id}/accept`, b),
  advance: (id: string, b: AdvanceBody) => http<Advance>(rider, "POST", `/riders/jobs/${id}/advance`, b),
  cancel: (id: string, b: CancelJobBody) => http<{ success: boolean }>(rider, "POST", `/riders/jobs/${id}/cancel`, b),
};

// ─── Shared steps ────────────────────────────────────────────────────
let customerName = "Customer";
let customerPhone: string | null = null;
let riderGender: string | null = null;
/** The rider's vehicle_type as last written / read. */
let riderVehicle: string | null = null;
/** The rider as found, put back at the end. */
let snapshot: { vehicle: string | null; available: boolean; lat: number | null; lng: number | null } | null = null;

const pt = (p: Pt): Pt => ({ lat: p.lat, lng: p.lng });
const point = (p: Place) => ({ label: p.label, address: p.address, lat: p.lat, lng: p.lng });

function rideBody(over: Partial<RideBody> = {}): RideBody {
  return {
    pickup: { ...point(GRANDE_POSTE), note: PICKUP_NOTE },
    destination: point(HYDRA),
    passenger: null,
    vehicle_type: "motorcycle",
    ...over,
  };
}

/** The rider online at `p` on `vehicle`, ready for offers. */
async function riderAt(p: Pt, vehicle: Vehicle = "motorcycle") {
  if (riderVehicle !== vehicle) {
    const r = expectStatus(await R.setVehicle({ vehicle_type: vehicle }), 200, `PATCH /riders/profile vehicle_type=${vehicle}`);
    riderVehicle = r.profile.vehicle_type;
    eq(riderVehicle, vehicle, "rider vehicle_type after PATCH /riders/profile");
  }
  expectStatus(
    await R.location({ latitude: p.lat, longitude: p.lng, is_available: true }),
    200,
    "PATCH /riders/location"
  );
}

async function requestRide(over: Partial<RideBody> = {}): Promise<Order> {
  const { order } = expectStatus(await C.request(rideBody(over)), 201, "POST /ride/requests");
  step(`ride ${order.id} requested (${order.status}, ${order.total} DZD)`);
  return order;
}

async function getOrder(id: string): Promise<Order> {
  return expectStatus(await C.order(id), 200, `GET /orders/${id}`).order;
}

/** The rider's offer is this ride (polls a few seconds). */
async function offerFor(id: string): Promise<RiderJob> {
  let last: RiderJob | undefined;
  for (let i = 0; i < 4; i++) {
    last = expectStatus(await R.offer(), 200, "GET /riders/jobs/offer").job;
    if (last?.id === id) return last;
    await sleep(1000);
  }
  throw new Fail(
    `rider offer: expected ride ${id}, got ${last ? `${last.type} ${last.id} (${last.pickup_distance_km} km away)` : "no offer"}`
  );
}

async function expectNotOffered(id: string, why: string) {
  const job = expectStatus(await R.offer(), 200, "GET /riders/jobs/offer").job;
  check(job?.id !== id, `the rider was offered ride ${id} although ${why}`);
  step(`not offered to the rider (${why})`);
}

/** A ride accepted by the dev rider (heading_to_store). */
async function acceptedRide(over: Partial<RideBody> = {}) {
  await riderAt(GRANDE_POSTE);
  const order = await requestRide(over);
  await offerFor(order.id);
  const { job } = expectStatus(await R.accept(order.id), 200, "POST /riders/jobs/{id}/accept");
  eq(job.status, "heading_to_store", "accepted job status");
  step("rider accepted");
  return { order, job };
}

async function advance(id: string, s: AdvanceBody["step"], status: string): Promise<Advance> {
  const r = expectStatus(await R.advance(id, { step: s }), 200, `advance ${s}`);
  eq(r.job.status, status, `job status after ${s}`);
  step(`advance ${s} -> ${status}`);
  return r;
}

async function riderHasNoJob(id: string) {
  const cur = expectStatus(await R.current(), 200, "GET /riders/jobs/current").job;
  check(cur?.id !== id, `ride ${id} is still the rider's current job (${cur?.status})`);
}

async function couponById(id: string) {
  return expectStatus(await C.coupons(), 200, "GET /coupons").coupons.find((c) => c.id === id);
}

/** An active coupon of the dev customer usable on a `fare` DZD ride, if any. */
async function findCoupon(fare: number): Promise<Coupon | null> {
  const r = await C.coupons();
  if (r.status !== 200) return null;
  return r.body.coupons.find((c) => c.status === "active" && Number(c.min_order ?? 0) <= fare) ?? null;
}

// ─── Cleanup + restore ───────────────────────────────────────────────
/** End a ride this run left live. null = done, else what went wrong. */
async function settle(id: string): Promise<string | null> {
  const r = await C.order(id);
  if (r.status !== 200) return `GET /orders/${id} -> ${r.status} ${errText(r.body)}`;
  const o = r.body.order;
  if (!LIVE.includes(o.status)) {
    open.delete(id);
    return null;
  }
  if (CUSTOMER_CANCELABLE.includes(o.status)) {
    const c = await C.cancel(id, { cancel_reason: "other", cancel_note: `${E2E} cleanup` });
    if (c.status !== 200) return `cleanup cancel of ${id} (${o.status}) -> ${c.status} ${errText(c.body)}`;
    step(`cleanup: canceled ${id} (was ${o.status})`);
  } else if (o.rider_id === rider.id) {
    // On board: only the rider can end it.
    const d = await R.advance(id, { step: "delivered" });
    if (d.status !== 200) return `cleanup delivery of ${id} -> ${d.status} ${errText(d.body)}`;
    step(`cleanup: delivered ${id}`);
  } else {
    return `ride ${id} is ${o.status} with another rider — end it by hand`;
  }
  open.delete(id);
  return null;
}

async function cleanup(includeParked: boolean): Promise<string[]> {
  const problems: string[] = [];
  for (const id of [...open]) {
    if (parked.has(id) && !includeParked) continue;
    try {
      const p = await settle(id);
      if (p) problems.push(p);
    } catch (e) {
      problems.push(`cleanup of ${id}: ${(e as Error).message}`);
    }
  }
  return problems;
}

async function restoreRider(): Promise<{ problems: string[]; notes: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!snapshot) return { problems, notes };
  const { vehicle, available, lat, lng } = snapshot;
  try {
    if (vehicle === "motorcycle" || vehicle === "bicycle") {
      if (riderVehicle !== vehicle) {
        const r = await R.setVehicle({ vehicle_type: vehicle });
        if (r.status === 200) riderVehicle = vehicle;
        else problems.push(`restore vehicle_type=${vehicle} -> ${r.status} ${errText(r.body)}`);
      }
    } else if (riderVehicle !== vehicle) {
      notes.push(`the rider's vehicle_type was ${show(vehicle)}; the API can't write that back, left as ${show(riderVehicle)}`);
    }
    const r =
      lat != null && lng != null
        ? await R.location({ latitude: lat, longitude: lng, is_available: available })
        : await R.availability({ is_available: available });
    if (r.status !== 200) problems.push(`restore rider availability/position -> ${r.status} ${errText(r.body)}`);
    else
      notes.push(
        `rider restored: ${riderVehicle ?? "no vehicle"}, ${available ? "online" : "offline"}` +
          (lat != null && lng != null ? ` at ${lat},${lng}` : " (no position was set; it now keeps the test pickup)")
      );
  } catch (e) {
    problems.push(`restore rider: ${(e as Error).message}`);
  }
  return { problems, notes };
}

// ─── Scenarios ───────────────────────────────────────────────────────
type Outcome = "PASS" | "FAIL" | "SKIP";
const results: { id: string; title: string; outcome: Outcome; reason: string }[] = [];

async function scenario(id: string, title: string, fn: () => Promise<string | void>) {
  if (ONLY.size && !ONLY.has(id)) return;
  console.log(`\n> ${id}. ${title}`);
  let outcome: Outcome = "PASS";
  let reason = "";
  try {
    reason = (await fn()) ?? "";
  } catch (e) {
    outcome = e instanceof Skip ? "SKIP" : "FAIL";
    reason = e instanceof Error ? e.message : String(e);
  }
  // Whatever happened, no ride of this scenario stays live.
  const problems = await cleanup(false);
  if (problems.length) {
    outcome = outcome === "SKIP" ? "SKIP" : "FAIL";
    reason = [reason, ...problems.map((p) => `cleanup: ${p}`)].filter(Boolean).join("; ");
  }
  results.push({ id, title, outcome, reason });
  console.log(`${outcome} ${id}. ${title}${reason ? ` — ${reason}` : ""}`);
}

// A. Quote → request → offer → accept → arrived → picked up → delivered → rating.
async function happyPath() {
  await riderAt(GRANDE_POSTE);

  const q = expectStatus(await C.quote({ pickup: pt(GRANDE_POSTE), destination: pt(HYDRA) }), 200, "POST /ride/quote");
  eq(q.options.length, 1, "quote options");
  const o = q.options[0];
  eq(o.vehicle_type, "motorcycle", "quote vehicle_type");
  eq(q.distance_km, KM, "quote distance_km");
  eq(o.fare, FARE, "quote fare");
  eq(o.discount, 0, "quote discount");
  eq(o.total, FARE, "quote total");
  eq(o.duration_minutes, DURATION, "quote duration_minutes");
  eq(o.available, true, "quote available");
  eq(o.unavailable_reason, null, "quote unavailable_reason");
  check(o.nearby_riders >= 1, `quote nearby_riders = ${o.nearby_riders}, the dev rider is online at the pickup`);
  eq(o.pickup_eta_minutes, pickupEta(0), "quote pickup_eta_minutes (rider at the pickup)");
  eq(q.coupon, undefined, "quote coupon without a coupon_code");
  step(`quote ${KM} km, ${FARE} DZD, ${DURATION} min, ${o.nearby_riders} rider(s) nearby`);

  const order = await requestRide();
  eq(order.type, "ride", "order type");
  eq(order.status, "searching", "order status");
  eq(order.rider_id, null, "order rider_id");
  eq(order.store_name, "Ride", "order store_name");
  eq(order.vehicle_type, "motorcycle", "order vehicle_type");
  eq(order.subtotal, 0, "order subtotal");
  eq(order.delivery_fee, FARE, "order delivery_fee (= fare)");
  eq(order.discount, 0, "order discount");
  eq(order.total, FARE, "order total");
  eq(order.pickup_lat, GRANDE_POSTE.lat, "order pickup_lat");
  eq(order.destination_lng, HYDRA.lng, "order destination_lng");
  const ride = order.ride;
  check(ride, "order.ride is null");
  eq(ride.pickup.label, GRANDE_POSTE.label, "ride.pickup.label");
  eq(ride.pickup.address, GRANDE_POSTE.address, "ride.pickup.address");
  eq(ride.pickup.note, PICKUP_NOTE, "ride.pickup.note");
  eq(ride.destination.label, HYDRA.label, "ride.destination.label");
  eq(ride.destination.lat, HYDRA.lat, "ride.destination.lat");
  eq(ride.passenger, null, "ride.passenger");
  eq(ride.distance_km, KM, "ride.distance_km");
  eq(ride.duration_minutes, DURATION, "ride.duration_minutes");
  eq(ride.female_rider_only, false, "ride.female_rider_only");
  eq(ride.arrived_at, null, "ride.arrived_at");

  const offer = await offerFor(order.id);
  eq(offer.type, "ride", "offer type");
  eq(offer.status, "searching", "offer status");
  eq(offer.fare, FARE, "offer fare");
  eq(offer.order_total, FARE, "offer order_total");
  eq(offer.distance_km, KM, "offer distance_km");
  eq(offer.duration_minutes, DURATION, "offer duration_minutes");
  eq(offer.pickup_distance_km, 0, "offer pickup_distance_km");
  eq(offer.pickup.label, GRANDE_POSTE.label, "offer pickup.label");
  eq(offer.destination.label, HYDRA.label, "offer destination.label");
  check(offer.ride, "offer.ride is null");
  eq(offer.ride.passenger_name, customerName, "offer ride.passenger_name (the customer)");
  eq(offer.ride.passenger_phone, customerPhone, "offer ride.passenger_phone");
  eq(offer.ride.for_someone_else, false, "offer ride.for_someone_else");
  eq(offer.ride.pickup_note, PICKUP_NOTE, "offer ride.pickup_note");
  eq(offer.ride.arrived_at, null, "offer ride.arrived_at");
  eq(offer.ride.female_rider_only, false, "offer ride.female_rider_only");
  step("offered to the rider");

  const { job } = expectStatus(await R.accept(order.id), 200, "POST /riders/jobs/{id}/accept");
  eq(job.status, "heading_to_store", "accepted job status");
  check(job.trip_id, "accepted job has no trip_id");
  step("rider accepted");

  let seen = await getOrder(order.id);
  eq(seen.status, "heading_to_store", "customer sees status");
  eq(seen.rider_id, rider.id, "order rider_id");
  check(seen.rider, "customer order has no rider card");
  eq(seen.rider.id, rider.id, "rider card id");
  eq(seen.rider.vehicle_type, "motorcycle", "rider card vehicle_type");
  check(seen.rider.location, "rider card has no live location while heading to the pickup");

  const arrived = await advance(order.id, "arrived", "pickup");
  check(arrived.job.ride?.arrived_at, "job ride.arrived_at not set after arrived");
  seen = await getOrder(order.id);
  eq(seen.status, "pickup", "customer sees status after arrived");
  check(seen.ride?.arrived_at, "order ride.arrived_at not set after arrived");

  await advance(order.id, "picked_up", "on_the_way");
  seen = await getOrder(order.id);
  eq(seen.status, "on_the_way", "customer sees status after picked_up");
  check(seen.picked_up_at, "order picked_up_at not set");

  const done = await advance(order.id, "delivered", "delivered");
  check(done.summary, "no trip summary after delivered");
  const net = Math.round(FARE * (1 - COMMISSION_RATE));
  eq(done.summary.total_fare, FARE, "summary total_fare");
  eq(done.summary.net_payout, net, "summary net_payout");
  eq(done.summary.commission, FARE - net, "summary commission");
  eq(done.summary.distance_km, KM, "summary distance_km");
  eq(done.summary.duration_minutes, DURATION, "summary duration_minutes (the priced ride duration)");
  seen = await getOrder(order.id);
  eq(seen.status, "delivered", "customer sees status after delivered");
  check(seen.delivered_at, "order delivered_at not set");
  await riderHasNoJob(order.id);

  expectStatus(await C.rateStore(order.id, { rating: 5 }), 400, "POST /orders/{id}/rate (store rating) on a ride");
  const tags = ["polite", "on_time"];
  const rated = expectStatus(
    await C.rateRider(order.id, { rating: 5, tags, review: `${E2E} smooth ride` }),
    200,
    "POST /orders/{id}/rate-rider"
  ).order;
  eq(rated.rider_rating, 5, "rate-rider rider_rating");
  check(
    tags.every((t) => rated.rider_tags?.includes(t)),
    `rate-rider rider_tags: expected ${show(tags)}, got ${show(rated.rider_tags)}`
  );
  seen = await getOrder(order.id);
  eq(seen.rider_rating, 5, "GET rider_rating");
  check(seen.rider?.rating != null, "rider card rating still null after a rating");
  step("rated 5 with tags");
  return `${KM} km · ${FARE} DZD · ${DURATION} min`;
}

// B. Customer cancels while searching (and can't use the rider / system reasons).
async function cancelWhileSearching() {
  await riderAt(GRANDE_POSTE);
  const order = await requestRide();
  for (const reason of ["passenger_no_show", "no_rider"]) {
    expectStatus(await C.cancel(order.id, { cancel_reason: reason }), 400, `customer cancel with cancel_reason ${reason}`);
    step(`cancel_reason ${reason} refused`);
  }
  eq((await getOrder(order.id)).status, "searching", "status after the refused cancels");
  const c = expectStatus(
    await C.cancel(order.id, { cancel_reason: "changed_mind", cancel_note: `${E2E} B` }),
    200,
    "customer cancel (changed_mind)"
  ).order;
  eq(c.status, "canceled", "status");
  eq(c.canceled_by, "customer", "canceled_by");
  eq(c.cancel_reason, "changed_mind", "cancel_reason");
  eq(c.cancel_note, `${E2E} B`, "cancel_note");
  await expectNotOffered(order.id, "it was canceled");
  expectStatus(await R.accept(order.id), 409, "accept a canceled ride");
}

// C. Customer cancels once the rider has arrived (ride booked for someone else).
async function cancelAfterArrival() {
  const passenger = { name: `${E2E} Passenger`, phone: "0550000099" };
  await riderAt(GRANDE_POSTE);
  const order = await requestRide({ passenger });
  eq(order.ride?.passenger?.name, passenger.name, "ride.passenger.name");
  eq(order.ride?.passenger?.phone, passenger.phone, "ride.passenger.phone");
  const offer = await offerFor(order.id);
  eq(offer.ride?.for_someone_else, true, "offer ride.for_someone_else");
  eq(offer.ride?.passenger_name, passenger.name, "offer ride.passenger_name");
  eq(offer.ride?.passenger_phone, passenger.phone, "offer ride.passenger_phone");
  expectStatus(await R.accept(order.id), 200, "POST /riders/jobs/{id}/accept");
  await advance(order.id, "arrived", "pickup");
  const c = expectStatus(
    await C.cancel(order.id, { cancel_reason: "waiting_too_long", cancel_note: `${E2E} C` }),
    200,
    "customer cancel at the pickup"
  ).order;
  eq(c.status, "canceled", "status");
  eq(c.canceled_by, "customer", "canceled_by");
  eq(c.cancel_reason, "waiting_too_long", "cancel_reason");
  await riderHasNoJob(order.id);
  expectStatus(await R.advance(order.id, { step: "picked_up" }), "4xx", "picked_up on a canceled ride");
}

// K. A ride can't skip "I've arrived": picked_up straight from heading_to_store.
async function noSkippingArrival() {
  const { order } = await acceptedRide();
  const r = await R.advance(order.id, { step: "picked_up" });
  expectStatus(r, "4xx", "picked_up without arrived");
  const seen = await getOrder(order.id);
  eq(seen.status, "heading_to_store", "status after the refused picked_up");
  eq(seen.picked_up_at, null, "picked_up_at after the refused picked_up");
  return `${r.status} ${errText(r.body)}`;
}

// E. passenger_no_show: refused before arriving, and right after (no_show_too_early).
async function noShowGuards() {
  const { order } = await acceptedRide();
  expectStatus(await R.cancel(order.id, { reason: "passenger_no_show" }), 400, "passenger_no_show before arriving");
  let seen = await getOrder(order.id);
  eq(seen.status, "heading_to_store", "status after the early no-show");
  eq(seen.rider_id, rider.id, "rider_id after the early no-show");
  step("no-show before arriving refused");

  await advance(order.id, "arrived", "pickup");
  const r = await R.cancel(order.id, { reason: "passenger_no_show" });
  expectStatus(r, 400, "passenger_no_show right after arriving");
  check(hasCode(r.body, "no_show_too_early"), `expected code no_show_too_early, got ${show(r.body)}`);
  seen = await getOrder(order.id);
  eq(seen.status, "pickup", "status after the too-early no-show");
  eq(seen.rider_id, rider.id, "rider_id after the too-early no-show");
  eq(seen.cancel_reason, null, "cancel_reason after the too-early no-show");
  step("no-show right after arriving refused (no_show_too_early)");
}

// D. A real no-show, 5 minutes after arriving: the ride ends, canceled by the rider.
async function noShow() {
  if (!SLOW) throw new Skip("needs a 5-minute wait at the pickup — rerun with --slow");
  const { order } = await acceptedRide();
  const arrivedAt = Date.now();
  await advance(order.id, "arrived", "pickup");
  await waitUntil(arrivedAt + NO_SHOW_WAIT_MS + 15_000, "waiting for the passenger");
  expectStatus(await R.cancel(order.id, { reason: "passenger_no_show" }), 200, "passenger_no_show after 5 min");
  const seen = await getOrder(order.id);
  eq(seen.status, "canceled", "status");
  eq(seen.canceled_by, "rider", "canceled_by");
  eq(seen.cancel_reason, "passenger_no_show", "cancel_reason");
  await riderHasNoJob(order.id);
  expectStatus(await C.cancel(order.id, { cancel_reason: "other" }), 400, "customer cancel of an ended ride");
}

// F. The rider drops the ride on the way: back to searching, never re-offered to them.
async function riderDrops() {
  const { order } = await acceptedRide();
  expectStatus(await R.cancel(order.id, { reason: `${E2E} vehicle issue` }), 200, "rider drops the ride");
  const seen = await getOrder(order.id);
  eq(seen.status, "searching", "status after the drop");
  eq(seen.rider_id, null, "rider_id after the drop");
  eq(seen.rider, undefined, "rider card after the drop");
  eq(seen.canceled_at, null, "canceled_at after the drop");
  eq(seen.ride?.arrived_at ?? null, null, "ride.arrived_at after the drop");
  check(seen.accepted_at, "accepted_at not set: the search window didn't restart");
  await riderHasNoJob(order.id);
  await expectNotOffered(order.id, "this rider dropped it");
  expectStatus(await R.accept(order.id), 409, "re-accept a dropped ride");
}

// F2. Dropped at the pickup: arrived_at is reset for the next rider.
async function riderDropsAtPickup() {
  const { order } = await acceptedRide();
  await advance(order.id, "arrived", "pickup");
  expectStatus(await R.cancel(order.id, { reason: `${E2E} emergency` }), 200, "rider drops the ride at the pickup");
  const seen = await getOrder(order.id);
  eq(seen.status, "searching", "status after the drop");
  eq(seen.rider_id, null, "rider_id after the drop");
  eq(seen.ride?.arrived_at ?? null, null, "ride.arrived_at after the drop");
}

// G. Validation.
async function validation() {
  const close = expectStatus(
    await C.quote({ pickup: pt(GRANDE_POSTE), destination: pt(GRANDE_POSTE) }),
    200,
    "quote, same point"
  ).options[0];
  eq(close?.available, false, "too-close quote available");
  eq(close?.unavailable_reason, "too_close", "too-close quote unavailable_reason");
  expectStatus(
    await C.request(rideBody({ destination: { ...point(GRANDE_POSTE), label: `${E2E} same point` } })),
    400,
    "request, same point"
  );
  step("too close: quote unavailable, request 400");

  const farKm = rideKm(GRANDE_POSTE, BLIDA);
  check(farKm > RATE.maxKm, `test setup: Blida is only ${farKm} road km away`);
  const far = expectStatus(await C.quote({ pickup: pt(GRANDE_POSTE), destination: pt(BLIDA) }), 200, "quote, Blida");
  eq(far.distance_km, farKm, "too-far quote distance_km");
  eq(far.options[0]?.available, false, "too-far quote available");
  eq(far.options[0]?.unavailable_reason, "too_far", "too-far quote unavailable_reason");
  expectStatus(await C.request(rideBody({ destination: point(BLIDA) })), 400, `request, ${farKm} km`);
  step(`too far (${farKm} km): quote unavailable, request 400`);

  expectStatus(
    await C.request(rideBody({ scheduled_at: new Date(Date.now() + 2 * 60_000).toISOString() })),
    400,
    "request scheduled 2 min ahead"
  );
  expectStatus(await C.request(rideBody({ vehicle_type: "bicycle" })), 400, "request vehicle_type bicycle");
  step("schedule < 10 min ahead and vehicle_type bicycle: 400");

  const legacy: Omit<CreateOrderBody, "type"> & { type: "ride" } = {
    store_name: "Ride",
    type: "ride",
    items: [{ name: `${E2E} Hydra`, quantity: 1, unit_price: 0 }],
    subtotal: 0,
    delivery_fee: FARE,
    service_fee: 0,
    pickup_address: GRANDE_POSTE.address,
    destination_address: HYDRA.address,
    pickup_lat: GRANDE_POSTE.lat,
    pickup_lng: GRANDE_POSTE.lng,
    destination_lat: HYDRA.lat,
    destination_lng: HYDRA.lng,
    vehicle_type: "motorcycle",
  };
  expectStatus(await C.createOrder(legacy), 400, "POST /orders {type: ride}");
  step("POST /orders type ride: 400");
}

// H. female_rider_only with the (male) dev rider.
async function femaleRiderOnly() {
  if (riderGender !== "male") throw new Skip(`the dev rider's gender is ${show(riderGender)}, not "male"`);
  await riderAt(GRANDE_POSTE);
  const body = { pickup: pt(GRANDE_POSTE), destination: pt(HYDRA) };
  const all = expectStatus(await C.quote(body), 200, "quote").options[0];
  const fem = expectStatus(await C.quote({ ...body, female_rider_only: true }), 200, "quote female_rider_only").options[0];
  check(
    fem.nearby_riders < all.nearby_riders,
    `female-only quote counts ${fem.nearby_riders} rider(s) vs ${all.nearby_riders} overall: the male dev rider is counted`
  );
  let note = "";
  if (fem.nearby_riders === 0) {
    eq(fem.available, false, "female-only quote available");
    eq(fem.unavailable_reason, "no_female_rider", "female-only quote unavailable_reason");
    eq(fem.pickup_eta_minutes, null, "female-only quote pickup_eta_minutes");
    step("quote: no_female_rider");
  } else {
    note = `${fem.nearby_riders} female rider(s) online nearby, so no_female_rider wasn't exercised`;
  }
  const order = await requestRide({ female_rider_only: true });
  eq(order.ride?.female_rider_only, true, "ride.female_rider_only");
  await expectNotOffered(order.id, "the passenger asked for a female rider");
  const acc = await R.accept(order.id);
  expectStatus(acc, 409, "male rider accepts a female-only ride");
  step(`accept refused: ${errText(acc.body)}`);
  return note;
}

// I. A bicycle rider never gets a ride.
async function bicycle() {
  await riderAt(GRANDE_POSTE, "motorcycle");
  const body = { pickup: pt(GRANDE_POSTE), destination: pt(HYDRA) };
  const before = expectStatus(await C.quote(body), 200, "quote").options[0].nearby_riders;
  try {
    await riderAt(GRANDE_POSTE, "bicycle");
    step("rider switched to bicycle");
    const after = expectStatus(await C.quote(body), 200, "quote").options[0].nearby_riders;
    check(after < before, `quote nearby_riders ${before} -> ${after}: the bicycle rider is still counted`);
    const order = await requestRide();
    await expectNotOffered(order.id, "the rider is on a bicycle");
    const acc = await R.accept(order.id);
    expectStatus(acc, 409, "bicycle rider accepts a ride");
    step(`accept refused: ${errText(acc.body)}`);
  } finally {
    await riderAt(GRANDE_POSTE, "motorcycle");
    step("rider back on the motorcycle");
  }
}

// L. A coupon is applied to the fare, and released when the customer cancels while searching.
async function couponReleased() {
  if (NO_COUPON) throw new Skip("--no-coupon");
  const coupon = await findCoupon(FARE);
  if (!coupon) throw new Skip(`the dev customer holds no active coupon usable on a ${FARE} DZD ride (GET /coupons)`);
  step(`using coupon ${coupon.code} (${coupon.discount_label})`);
  const q = expectStatus(
    await C.quote({ pickup: pt(GRANDE_POSTE), destination: pt(HYDRA), coupon_code: coupon.code }),
    200,
    "quote with coupon"
  );
  check(q.coupon?.valid, `quote: coupon ${coupon.code} invalid (${q.coupon?.reason})`);
  const discount = q.options[0].discount;
  check(discount > 0, `quote discount is ${discount}`);
  eq(q.options[0].total, Math.max(0, FARE - discount), "quote total with coupon");
  const order = await requestRide({ coupon_code: coupon.code });
  eq(order.discount, discount, "order discount");
  eq(order.total, Math.max(0, FARE - discount), "order total");
  eq(order.coupon_id, coupon.id, "order coupon_id");
  const used = await couponById(coupon.id);
  eq(used?.status, "used", "coupon status after the request");
  expectStatus(await C.cancel(order.id, { cancel_reason: "changed_mind" }), 200, "customer cancel");
  const after = await couponById(coupon.id);
  check(
    after?.status === "active",
    `coupon ${coupon.code} not released after the cancel (status ${show(after?.status)}) — it stays consumed on the dev account`
  );
  return `${coupon.code}: −${discount} DZD, released`;
}

// J. Expiry: an unclaimed ride is canceled (system, no_rider) 10 min after going live.
let expiry: { order: Order; at: number; coupon: Coupon | null } | null = null;
let expirySetupError = "";

/** J's ride is requested first so its 10 minutes run alongside the other scenarios. */
async function startExpiry() {
  try {
    const coupon = NO_COUPON ? null : await findCoupon(rideFare(rideKm(BOUMERDES, BOUMERDES_EAST)));
    const order = await requestRide({
      pickup: { ...point(BOUMERDES), note: null },
      destination: point(BOUMERDES_EAST),
      ...(coupon ? { coupon_code: coupon.code } : {}),
    });
    parked.add(order.id);
    expiry = { order, at: Date.now(), coupon };
    console.log(`  (J) ride ${order.id} left searching at Boumerdes${coupon ? ` with coupon ${coupon.code}` : ""}`);
  } catch (e) {
    expirySetupError = (e as Error).message;
  }
}

async function expires() {
  if (!EXPIRY) {
    throw new Skip("needs a real 10-minute wait (created_at can't be backdated through the API) — rerun with --expiry");
  }
  check(expiry, `the expiry ride wasn't created: ${expirySetupError}`);
  const { order, at, coupon } = expiry;
  await waitUntil(at + SEARCH_TIMEOUT_MS + 30_000, "search window");
  // The cron and GET /orders/{id} (lazy) both expire it; either may get there first.
  const cron = await http<{ checked?: number; canceled?: number }>(
    null,
    "POST",
    "/cron/search-timeouts",
    undefined,
    CRON_SECRET ? { "x-cron-secret": CRON_SECRET } : {}
  );
  step(`POST /cron/search-timeouts -> ${cron.status} ${JSON.stringify(cron.body)}`);
  const seen = await getOrder(order.id);
  parked.delete(order.id);
  eq(seen.status, "canceled", "status after 10 min");
  eq(seen.canceled_by, "system", "canceled_by");
  eq(seen.cancel_reason, "no_rider", "cancel_reason");
  eq(seen.rider_id, null, "rider_id");
  open.delete(order.id);
  let note = `cron ${cron.status}`;
  if (coupon) {
    const after = await couponById(coupon.id);
    check(after?.status === "active", `coupon ${coupon.code} not released on no_rider (status ${show(after?.status)})`);
    note += `, coupon ${coupon.code} released`;
  }
  return note;
}

// ─── Preflight ───────────────────────────────────────────────────────
async function preflight() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY missing (.env, or tsx --env-file=.env.arch.local)");
  }
  const host = new URL(SUPABASE_URL).host;
  console.log(`API ${API_URL} · Supabase ${host}`);
  if (/\.supabase\.co$/i.test(host) && !ALLOW_CLOUD) {
    throw new Error(
      `refusing to create test rides on the hosted project ${host}; run against arch (tsx --env-file=.env.arch.local …) or pass --allow-cloud`
    );
  }
  const health = await http<{ status?: string; version?: string }>(null, "GET", "/health").catch((e: Error) => {
    throw new Error(`API not reachable at ${API_URL}: ${e.message}`);
  });
  if (health.status !== 200) throw new Error(`GET /health -> ${health.status}`);
  console.log(`API version ${health.body.version ?? "?"}`);

  customer = await signIn("customer", CUSTOMER_EMAIL);
  rider = await signIn("rider", RIDER_EMAIL);
  const cp = expectStatus(await C.profile(), 200, "customer GET /auth/profile");
  eq(cp.user.role, "customer", `${CUSTOMER_EMAIL} role`);
  customerName = [cp.user.first_name, cp.user.last_name].filter(Boolean).join(" ").trim() || "Customer";
  customerPhone = cp.user.phone_number ?? null;
  const rp = expectStatus(await R.profile(), 200, "rider GET /auth/profile");
  eq(rp.user.role, "rider", `${RIDER_EMAIL} role`);
  check(rp.rider_profile, `${RIDER_EMAIL} has no rider_profiles row`);
  riderGender = rp.user.gender ?? null;
  riderVehicle = rp.rider_profile.vehicle_type ?? null;
  snapshot = {
    vehicle: riderVehicle,
    available: rp.rider_profile.is_available ?? false,
    lat: rp.rider_profile.latitude ?? null,
    lng: rp.rider_profile.longitude ?? null,
  };
  console.log(
    `customer "${customerName}" · rider ${riderGender ?? "?"}, ${riderVehicle ?? "no vehicle"}, ` +
      `${snapshot.available ? "online" : "offline"} · expected ${KM} km / ${FARE} DZD / ${DURATION} min`
  );

  // Rides an interrupted earlier run left live (labelled [e2e]).
  const list = expectStatus(await C.orders(), 200, "GET /orders");
  for (const o of list.orders ?? []) {
    if (o.type === "ride" && o.ride?.pickup.label.startsWith(E2E) && LIVE.includes(o.status)) open.add(o.id);
  }
  const cur = expectStatus(await R.current(), 200, "GET /riders/jobs/current").job;
  if (cur && !(cur.type === "ride" && cur.pickup.label.startsWith(E2E))) {
    throw new Error(`the dev rider is on job ${cur.id} (${cur.type}, ${cur.status}) — finish it first`);
  }
  if (cur) open.add(cur.id);
  if (open.size) {
    console.log(`cleaning up ${open.size} live ride(s) from an earlier run`);
    const problems = await cleanup(true);
    if (problems.length) throw new Error(problems.join("; "));
  }
}

// ─── Main ────────────────────────────────────────────────────────────
let finishing = false;

async function finish(): Promise<number> {
  finishing = true;
  const problems = await cleanup(true);
  const { problems: restoreProblems, notes } = await restoreRider();
  problems.push(...restoreProblems);
  console.log("\n──── Summary ────");
  for (const r of results) console.log(`${r.outcome.padEnd(4)}  ${r.id.padEnd(2)}  ${r.title}${r.reason ? ` — ${r.reason}` : ""}`);
  for (const n of notes) console.log(`note: ${n}`);
  for (const p of problems) console.log(`PROBLEM: ${p}`);
  const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
  console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
  return count("FAIL") || problems.length ? 1 : 0;
}

process.on("SIGINT", () => {
  if (finishing) process.exit(130);
  console.log("\nInterrupted: canceling this run's rides and restoring the rider…");
  finish().finally(() => process.exit(130));
});

async function main() {
  try {
    await preflight();
  } catch (e) {
    console.error(`FAIL preflight — ${(e as Error).message}`);
    const { problems } = await restoreRider();
    for (const p of problems) console.error(`PROBLEM: ${p}`);
    process.exit(1);
  }

  // L before J: both may use the same coupon.
  await scenario("L", "Coupon applied to the fare, released on a customer cancel while searching", couponReleased);
  if (EXPIRY && (!ONLY.size || ONLY.has("J"))) await startExpiry();

  await scenario("A", "Happy path: quote, request, offer, accept, arrived, on board, delivered, rating", happyPath);
  await scenario("B", "Customer cancels while searching (rider/system reasons refused)", cancelWhileSearching);
  await scenario("C", "Customer cancels after the rider arrived (ride for someone else)", cancelAfterArrival);
  await scenario("K", "picked_up without arrived is refused", noSkippingArrival);
  await scenario("E", "passenger_no_show before arriving, and right after (no_show_too_early), is refused", noShowGuards);
  await scenario("F", "Rider drops the ride on the way: back to searching, not re-offered to them", riderDrops);
  await scenario("F2", "Rider drops the ride at the pickup: arrived_at reset", riderDropsAtPickup);
  await scenario("G", "Validation: too close, too far, bad schedule, bicycle, POST /orders type ride", validation);
  await scenario("H", "female_rider_only: male rider not counted, not offered, accept 409", femaleRiderOnly);
  await scenario("I", "Bicycle rider: ride not offered, accept 409", bicycle);
  await scenario("D", "Passenger no-show after 5 min: canceled by the rider (--slow)", noShow);
  await scenario("J", "Unclaimed ride expires after 10 min: canceled, no_rider (--expiry)", expires);

  process.exit(await finish());
}

main().catch(async (e) => {
  console.error(`FAIL — ${(e as Error).message}`);
  await finish().catch(() => 1);
  process.exit(1);
});
