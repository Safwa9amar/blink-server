// Rider dispatch: the rider app polls for an offer while online, accepts it
// (atomic claim on the order), then drives it arrived → picked up → delivered.
// A multi-store checkout (orders sharing `checkout_id`) is ONE job for ONE
// rider: it is offered once every store has accepted, claimed all-or-nothing,
// advanced stop by stop (`order_id`) and delivered together. `{id}` may be any
// member's id. Every accepted job gets a `trips` row, which feeds trip history,
// earnings and the Blink Cash "trip tax" (commission) — except a store's
// own-driver delivery, which never pays Blink.
// A store may also ask ONE rider by name (merchant "assign a rider"): the
// order stays `searching` with a pending request (offered_*) that only that
// rider sees (request_kind) and only their accept assigns. Until it is
// answered or times out (TTL + grace) nobody else can take the order. Rules:
// src/lib/rider-offer.ts. When every store in a checkout is one merchant's,
// that merchant may ask its own driver for the WHOLE checkout: the request
// lives on every member, is shown as the bundle job and accepted all-or-nothing.
import {
  bundleAnswersRequest,
  bundleClaimComplete,
  bundleHeldForOtherRider,
  bundleMembers,
  bundleOfferedTo,
  bundleRequestVisibleTo,
  canCancelBundle,
  canDeliverBundle,
  isBundleOfferable,
  leadOrder,
  type BundleRow,
} from "../../lib/bundle";
import {
  bookedJobRows,
  createTripForBundle,
  createTripForOrder,
  currentJobRow,
  findConflict,
  IN_DELIVERY,
  isFreshOffer,
  isOfferable,
  loadBundle,
  notifyCourier,
  notifyCustomer,
  notifyRide,
  notifyStoreOwner,
  dropOffName,
  OFFER_RADIUS_KM,
  ORDER_SELECT,
  POST_ACCEPT_PENALTY,
  releaseRiderRequests,
  riderGender,
  riderNames,
  riderPosition,
  toBundleJob,
  toJobs,
} from "../../lib/dispatch";
import {
  acceptPatch,
  answersRequest,
  claimRollback,
  CLEAR_OFFER,
  isHeld,
  isHeldForOtherRider,
  isOfferedTo,
  isRequestVisibleTo,
  isScheduledBooking,
  liveSinceIso,
  poolClaimPatch,
} from "../../lib/rider-offer";
import { pickedUpPatch } from "../../lib/order-steps";
import { tripPayout } from "../../lib/cash-jobs";
import { courierOf, deliverCurrentDropOff, isCourierSearchExpired, remainingDropOffs, riderCanTake } from "../../lib/courier";
import {
  isPassengerNoShow,
  isRideSearchExpired,
  markRideArrived,
  NO_SHOW_TOO_EARLY,
  noShowWaitLeftMs,
  PASSENGER_NO_SHOW_REASON,
  rideCanPickUp,
  rideOf,
  rideRiderProblem,
  riderCanTakeRide,
  RIDE_NO_SHOW_WAIT_MS,
  startNoShowClock,
} from "../../lib/ride";
import { RIDER_NOT_VERIFIED, riderCanWork } from "../../lib/rider-access";
import { supabaseAdmin } from "../../lib/supabase";
import { orderRef } from "../merchant/shared";
import { RiderDataUnavailableError, riderAccess } from "./verification-shared";
import { bearer, createRoute, ErrorSchema, z, errorResponses, IdParam, json, OkSchema, router } from "../../openapi";
import {
  acceptJobSchema,
  advanceJobSchema,
  AdvanceJobResponse,
  cancelJobSchema,
  CancelRiderJobError,
  declineJobSchema,
  rateCustomerSchema,
  RiderJobListResponse,
  RiderJobOptionalResponse,
  RiderJobResponse,
  TripSummarySchema,
} from "../../validators/rider-jobs";
import { RiderNotVerifiedError } from "../../validators/riders";

const app = router();

type RiderPos = Awaited<ReturnType<typeof riderPosition>>;

/** The checkout members this rider holds. Rejected or canceled stores drop out. */
const riderMembers = (rows: BundleRow[], riderId: string) =>
  bundleMembers(rows).filter((m) => m.rider_id === riderId);

/** The rider's multi-store checkout as one RiderJob, or null once no store is left. */
async function riderBundleJob(checkoutId: string, riderId: string, rider: RiderPos) {
  const members = riderMembers(await loadBundle(checkoutId), riderId);
  return members.length ? toBundleJob(members, { rider }) : null;
}

/**
 * Compare-and-swap on a value as read: `column = value`, or `column IS NULL`
 * when it was null (PostgREST's `eq.null` compares with the text "null").
 */
function sameAs<Q extends { filter(column: string, operator: "eq" | "is", value: unknown): Q }>(
  query: Q,
  column: string,
  value: unknown
): Q {
  return value == null ? query.filter(column, "is", null) : query.filter(column, "eq", value);
}

/**
 * The store owner from a `store:stores(owner_id)` embed: an object at runtime
 * (many-to-one), though postgrest-js types a non-`*` embed as an array.
 */
const storeOwnerId = (o: { store?: unknown }) => (o.store as { owner_id?: string | null } | null)?.owner_id;

/** Order statuses in which a rider still holds a job they claimed (a booked one stays `searching`). */
const HELD_BY_RIDER = ["searching", ...IN_DELIVERY];

/**
 * After an accept's trip insert: does the rider still hold any of the orders
 * just claimed? A customer cancel can land between the claim and the insert,
 * and it only closes trips that exist by then. So a lost claim closes the
 * trip just created here (no penalty: the rider didn't cancel), and the accept
 * answers 409 without the "accepted" pushes or releasing the rider's other
 * store requests. A failed read counts as held: the accept stands as before.
 */
async function claimStillHeld(orderIds: string[], riderId: string) {
  const { data: rows, error } = await supabaseAdmin
    .from("orders")
    .select("status, rider_id, canceled_by")
    .in("id", orderIds);
  if (error || !rows) return true;
  if (rows.some((o) => o.rider_id === riderId && HELD_BY_RIDER.includes(o.status))) return true;
  const by = rows.find((o) => o.status === "canceled")?.canceled_by ?? "system";
  await supabaseAdmin
    .from("trips")
    .update({ status: "canceled", cancellation_reason: `canceled_by_${by}` })
    .in("order_id", orderIds)
    .eq("rider_id", riderId)
    .eq("status", "upcoming");
  return false;
}

/** An own-delivery request still points at one of the store's active drivers: this rider. */
async function isActiveStoreDriver(order: Record<string, any>, riderId: string) {
  if (!order.offered_driver_id || !order.store_id) return false;
  const { data } = await supabaseAdmin
    .from("store_drivers")
    .select("id")
    .eq("id", order.offered_driver_id)
    .eq("store_id", order.store_id)
    .eq("rider_user_id", riderId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

/** An own-driver checkout request still points at an active driver of one of its stores: this rider. */
async function isActiveCheckoutDriver(driverId: string | null, members: BundleRow[], riderId: string) {
  const storeIds = [...new Set(members.map((m) => m.store_id as string).filter(Boolean))];
  if (!driverId || !storeIds.length) return false;
  const { data } = await supabaseAdmin
    .from("store_drivers")
    .select("id")
    .eq("id", driverId)
    .in("store_id", storeIds)
    .eq("rider_user_id", riderId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

/** A checkout was accepted: the customer hears once, each store hears who's coming. */
async function notifyBundleAccepted(won: BundleRow[], riderId: string) {
  const lead = leadOrder(won);
  const ref = orderRef(lead.id);
  // Each store (not shopper hand-overs) hears who's coming for its order.
  const storeOrders = won.filter((o) => o.type === "merchant");
  const names = storeOrders.length ? await riderNames(riderId) : null;
  await Promise.all([
    notifyCustomer(
      lead.customer_id,
      { title: "Rider found", description: `A rider accepted your order ${ref} and will collect it from ${won.length} stores.` },
      { title: "Livreur trouvé", description: `Un livreur a accepté votre commande ${ref} et la récupérera dans ${won.length} magasins.` },
      { title: "تم العثور على سائق", description: `قبل سائق طلبك ${ref} وسيستلمه من ${won.length} متاجر.` }
    ),
    ...storeOrders.map((o) => {
      const storeRef = orderRef(o.id);
      return notifyStoreOwner(
        storeOwnerId(o),
        o.id,
        { title: `${names!.en} accepted order ${storeRef}`, description: "They're on the way to collect it." },
        { title: `${names!.fr} a accepté la commande ${storeRef}`, description: "Il arrive pour la récupérer." },
        { title: `قبل ${names!.ar} الطلب ${storeRef}`, description: "إنه في الطريق لاستلامه." }
      );
    }),
  ]);
}

// ─── GET /jobs/offer — the best open job for this rider ──────────────
// A store's request to this rider comes first (request_kind set). Otherwise
// single orders and multi-store checkouts are ranked together by pickup
// distance. A checkout is offered as one job once every store has accepted.
app.openapi(
  createRoute({
    method: "get",
    path: "/jobs/offer",
    operationId: "getRiderJobOffer",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderJobOptionalResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    const now = Date.now();
    const rider = await riderPosition(user.id);
    // Offline or not verified yet (src/lib/rider-access.ts): no offer at all.
    if (
      !rider.isAvailable ||
      !riderCanWork({ verification_status: rider.verificationStatus }) ||
      (await currentJobRow(user.id))
    ) {
      return c.json({}, 200);
    }

    // The store asked for this rider by name, so the pool's filters (radius,
    // freshness, an earlier decline) don't apply: a store may ask again.
    const { data: requests } = await supabaseAdmin
      .from("orders")
      .select(ORDER_SELECT)
      .eq("offered_rider_id", user.id)
      .is("rider_id", null)
      .eq("status", "searching")
      .is("offer_declined_at", null)
      .gt("offered_at", liveSinceIso(now))
      .order("offered_at", { ascending: true })
      .limit(1);
    const request = (requests ?? []).find((o) => isRequestVisibleTo(o, user.id, now));
    if (request?.checkout_id) {
      // A store's own-driver request for a whole checkout: shown as the bundle.
      // A member that changed meanwhile ends it: the pool takes over after TTL + grace.
      const members = bundleMembers(await loadBundle(request.checkout_id));
      if (bundleRequestVisibleTo(members, user.id, now)) {
        const job = await toBundleJob(members, { rider, viewerId: user.id, now });
        return c.json({ job }, 200);
      }
    } else if (request) {
      // A scheduled request still warns about a clashing booked job.
      const conflict = request.scheduled_at
        ? findConflict(await bookedJobRows(user.id), request.scheduled_at)
        : undefined;
      const [job] = await toJobs([request], {
        rider,
        withNearby: false,
        viewerId: user.id,
        now,
        conflicts: conflict ? new Map([[request.id, conflict]]) : undefined,
      });
      return c.json({ job }, 200);
    }

    const openOrders = () =>
      supabaseAdmin.from("orders").select(ORDER_SELECT).is("rider_id", null).eq("status", "searching");
    const [{ data: open }, { data: grouped }, { data: declined }, booked] = await Promise.all([
      openOrders().order("created_at", { ascending: false }).limit(100),
      // Checkout members get their own query so that heavy single-order traffic
      // can't push a bundle out of the 100-row window.
      openOrders().not("checkout_id", "is", null).order("created_at", { ascending: false }).limit(100),
      supabaseAdmin.from("rider_order_declines").select("order_id").eq("rider_id", user.id),
      bookedJobRows(user.id),
    ]);
    const skip = new Set((declined ?? []).map((d) => d.order_id));
    // A ride reserved for a female rider needs this rider's gender (read only then).
    const gender = (open ?? []).some((o) => o.type === "ride" && rideOf(o)?.female_rider_only)
      ? await riderGender(user.id)
      : null;

    // isOfferable() is false for checkout members, so a member is never offered alone.
    // An order held for a store's request (anyone's, this rider's too) stays
    // out of the pool; after TTL + grace it is an ordinary Blink job again.
    const singles = (open ?? []).filter(
      (o) =>
        isOfferable(o) &&
        isFreshOffer(o, now) &&
        !isHeld(o, now) &&
        !skip.has(o.id) &&
        o.customer_id !== user.id &&
        // A motorcycle courier request never goes to a bicycle.
        (o.type !== "courier" || riderCanTake(o.vehicle_type, rider.vehicleType)) &&
        // A ride needs a motorcycle (and a woman, when the customer asked for
        // one), and is never offered past its 10-minute search window.
        (o.type !== "ride" ||
          (riderCanTakeRide(o, { vehicleType: rider.vehicleType, gender }) && !isRideSearchExpired(o, now)))
    );

    // Every checkout with an open member is loaded whole, including members
    // outside the windows above. No freshness rule for checkouts: only real
    // checkouts carry `checkout_id`, and an age cut-off could strand a bundle
    // a rider released after 20 minutes.
    const checkoutIds = [
      ...new Set(
        [...(open ?? []), ...(grouped ?? [])]
          .map((o) => o.checkout_id as string | null)
          .filter((cid): cid is string => !!cid)
      ),
    ];
    // One query for every candidate checkout, grouped here.
    const { data: bundleRows } = checkoutIds.length
      ? await supabaseAdmin.from("orders").select(ORDER_SELECT).in("checkout_id", checkoutIds)
      : { data: [] as BundleRow[] };
    const byCheckout = new Map<string, BundleRow[]>();
    for (const r of bundleRows ?? []) {
      const list = byCheckout.get(r.checkout_id) ?? [];
      list.push(r);
      byCheckout.set(r.checkout_id, list);
    }
    const bundles = [...byCheckout.values()].flatMap((rows) => {
      const members = bundleMembers(rows);
      // A held member is defensive only: stores can't request a rider for a checkout.
      const offerable =
        isBundleOfferable(rows) &&
        !members.some((m) => skip.has(m.id) || m.customer_id === user.id || isHeld(m, now));
      return offerable ? [members] : [];
    });

    const ctx = { rider, viewerId: user.id, now };
    const [singleJobs, bundleJobs] = await Promise.all([
      toJobs(singles, ctx),
      Promise.all(bundles.map((members) => toBundleJob(members, ctx))),
    ]);
    const ranked = [
      ...singleJobs.map((j) => ({ id: j.id, km: j.pickup_distance_km, members: null as BundleRow[] | null })),
      ...bundleJobs.map((j, i) => ({ id: j.id, km: j.pickup_distance_km, members: bundles[i] })),
    ]
      .filter((j) => j.km == null || j.km <= OFFER_RADIUS_KM)
      .sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
    const best = ranked[0];
    if (!best) return c.json({}, 200);

    if (best.members) {
      const job = await toBundleJob(best.members, { ...ctx, withNearby: true });
      return c.json({ job }, 200);
    }
    const row = singles.find((o) => o.id === best.id)!;
    const conflict = findConflict(booked, row.scheduled_at);
    const [job] = await toJobs([row], {
      ...ctx,
      withNearby: true,
      conflicts: conflict ? new Map([[row.id, conflict]]) : undefined,
    });
    return c.json({ job }, 200);
  }
);

// ─── GET /jobs/current — the job in progress, if any ─────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/jobs/current",
    operationId: "getRiderCurrentJob",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderJobOptionalResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    const row = await currentJobRow(user.id);
    if (!row) return c.json({}, 200);
    const rider = await riderPosition(user.id);
    // Any assigned member of a checkout stands for the whole bundle.
    if (row.checkout_id) {
      const job = await riderBundleJob(row.checkout_id, user.id, rider);
      if (!job) return c.json({}, 200);
      return c.json({ job }, 200);
    }
    const [job] = await toJobs([row], { rider, viewerId: user.id });
    return c.json({ job }, 200);
  }
);

// ─── GET /jobs/booked — accepted scheduled jobs not yet started ──────
app.openapi(
  createRoute({
    method: "get",
    path: "/jobs/booked",
    operationId: "listRiderBookedJobs",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderJobListResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    const [rows, rider] = await Promise.all([bookedJobRows(user.id), riderPosition(user.id)]);
    const checkoutIds = [
      ...new Set(rows.map((r) => r.checkout_id as string | null).filter((cid): cid is string => !!cid)),
    ];
    const [singles, bundles] = await Promise.all([
      toJobs(rows.filter((r) => !r.checkout_id), { rider, viewerId: user.id }),
      Promise.all(checkoutIds.map((cid) => riderBundleJob(cid, user.id, rider))),
    ]);
    const jobs = [...singles, ...bundles.filter((j): j is NonNullable<typeof j> => j != null)];
    return c.json({ jobs }, 200);
  }
);

// ─── POST /jobs/{id}/accept — claim an open job ──────────────────────
// Immediate jobs start at once (heading_to_store); scheduled ones are booked
// (rider_id set, still `searching`) and started later via /start. A
// multi-store checkout is claimed whole (every store's order) or not at all.
// A store's request is the requested rider's alone until TTL + grace: their
// accept assigns it as asked (own driver or Blink); anyone else gets 409.
// Answering a request, the app echoes its request_expires_at: the accept then
// applies to that exact request only — a withdrawn / re-sent / lapsed one is
// 409, never silently turned into an ordinary Blink pool claim.
app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/accept",
    operationId: "acceptRiderJob",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(acceptJobSchema), required: false } },
    responses: {
      200: json(RiderJobResponse),
      400: errorResponses[400],
      403: json(RiderNotVerifiedError, "Rider not verified"),
      404: errorResponses[404],
      409: json(ErrorSchema, "Job already taken"),
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    // Every job type (store, courier, ride, a store's own-driver request)
    // needs a verified rider. A failed lookup never lets a rider through.
    try {
      if (!(await riderAccess(user.id))) return c.json(RIDER_NOT_VERIFIED, 403);
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return c.json({ error: "Service unavailable, please retry" }, 503);
      throw e;
    }
    const { id } = c.req.valid("param");
    // The store request the rider was shown, if they're answering one.
    const shown = (c.req.valid("json") ?? {}).request_expires_at;
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    const { data: order } = await supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", id).maybeSingle();
    if (!order) return c.json({ error: "Job not found" }, 404);

    // ─── Multi-store checkout: one rider claims every store's order ──
    if (order.checkout_id) {
      const rows = await loadBundle(order.checkout_id);
      const members = bundleMembers(rows);
      // A store's own-driver request for the whole checkout, answered by its driver.
      const requested =
        typeof shown === "string"
          ? bundleAnswersRequest(members, user.id, shown, now)
          : shown === undefined && bundleOfferedTo(members, user.id, now);
      if (typeof shown === "string" && !requested) {
        return c.json({ error: "This request is no longer available" }, 409);
      }
      if (requested) {
        if (await currentJobRow(user.id)) return c.json({ error: "Finish your current trip first" }, 400);
        const lead = leadOrder(members);
        // The store may have removed this driver since asking.
        if (!(await isActiveCheckoutDriver(lead.offered_driver_id, members, user.id))) {
          await supabaseAdmin
            .from("orders")
            .update(CLEAR_OFFER)
            .eq("checkout_id", order.checkout_id)
            .eq("offered_rider_id", user.id)
            .eq("offered_at", lead.offered_at)
            .is("rider_id", null);
          return c.json({ error: "This request is no longer available" }, 409);
        }
        const { data: claimedOwn } = await supabaseAdmin
          .from("orders")
          .update({
            rider_id: user.id,
            rider_assigned_at: nowIso,
            status: "heading_to_store",
            delivery_mode: "own",
            store_driver_id: lead.offered_driver_id,
            ...CLEAR_OFFER,
          })
          .eq("checkout_id", order.checkout_id)
          .is("rider_id", null)
          .eq("status", "searching")
          .eq("offered_rider_id", user.id)
          .eq("offered_at", lead.offered_at)
          .eq("offered_mode", "own")
          .is("offer_declined_at", null)
          .select(ORDER_SELECT);
        const wonOwn = claimedOwn ?? [];
        if (!bundleClaimComplete(wonOwn.length, members.length)) {
          if (wonOwn.length) {
            // Back to the request as read, so the driver can still answer it.
            await supabaseAdmin
              .from("orders")
              .update({
                rider_id: null,
                rider_assigned_at: null,
                status: "searching",
                delivery_mode: null,
                store_driver_id: null,
                offered_rider_id: lead.offered_rider_id,
                offered_driver_id: lead.offered_driver_id,
                offered_mode: lead.offered_mode,
                offered_at: lead.offered_at,
                offer_declined_at: null,
              })
              .in("id", wonOwn.map((o) => o.id))
              .eq("rider_id", user.id)
              .eq("status", "heading_to_store");
          }
          return c.json({ error: "This request is no longer available" }, 409);
        }
        // Own driver: no trip (no Blink commission), like a single own delivery.
        if (!(await claimStillHeld(wonOwn.map((o) => o.id as string), user.id))) {
          return c.json({ error: "This job is no longer available" }, 409);
        }
        await releaseRiderRequests(user.id);
        await notifyBundleAccepted(wonOwn, user.id);
        const job = await toBundleJob(wonOwn, { rider: await riderPosition(user.id) });
        return c.json({ job }, 200);
      }
      // A pool claim never takes a checkout a store asked a driver for.
      if (shown === null && bundleOfferedTo(members, user.id, now)) {
        return c.json({ error: "This job changed — check the new request" }, 409);
      }
      if (bundleHeldForOtherRider(members, user.id, now)) {
        return c.json({ error: "This job is no longer available" }, 409);
      }
      if (!isBundleOfferable(rows)) return c.json({ error: "This job is no longer available" }, 409);
      if (await currentJobRow(user.id)) return c.json({ error: "Finish your current trip first" }, 400);

      // A single conditional update is the atomic claim. Rejected and canceled
      // stores are never `searching`, so only members can match.
      const { data: claimed } = await supabaseAdmin
        .from("orders")
        // Stale (declined / expired) request columns go with the claim.
        .update({ rider_id: user.id, rider_assigned_at: nowIso, status: "heading_to_store", ...CLEAR_OFFER })
        .eq("checkout_id", order.checkout_id)
        .is("rider_id", null)
        .eq("status", "searching")
        .select(ORDER_SELECT);
      const won = claimed ?? [];
      // Hand back what this rider claimed (after a lost race or a failed trip insert).
      const release = () =>
        supabaseAdmin
          .from("orders")
          .update({ rider_id: null, rider_assigned_at: null, status: "searching", delivery_mode: null })
          .in("id", won.map((o) => o.id))
          .eq("rider_id", user.id)
          // Never revive an order the customer canceled meanwhile.
          .eq("status", "heading_to_store");
      if (!bundleClaimComplete(won.length, members.length)) {
        if (won.length) await release();
        return c.json({ error: "This job is no longer available" }, 409);
      }

      // Store orders switch to Blink delivery. Shopper orders have no delivery mode.
      const merchantIds = won.filter((o) => o.type === "merchant").map((o) => o.id);
      if (merchantIds.length) {
        await supabaseAdmin
          .from("orders")
          .update({ delivery_mode: "blink" })
          .in("id", merchantIds)
          .eq("rider_id", user.id);
      }
      try {
        await createTripForBundle(won, user.id);
      } catch (e) {
        await release();
        return c.json({ error: (e as Error).message }, 400);
      }
      if (!(await claimStillHeld(won.map((o) => o.id as string), user.id))) {
        return c.json({ error: "This job is no longer available" }, 409);
      }
      // On a job now: stores still waiting on this rider can pick someone else.
      await releaseRiderRequests(user.id);
      await notifyBundleAccepted(won, user.id);
      const job = await toBundleJob(won, { rider: await riderPosition(user.id) });
      return c.json({ job }, 200);
    }

    const scheduled = isScheduledBooking(order, now);
    // A store asked this rider and the request is still open (TTL + grace).
    // An answer naming a request must match it exactly; older apps send none.
    // null = the rider took it as an ordinary pool job: if a store has asked
    // them for it meanwhile, they must see that request's terms first.
    if (shown === null && isOfferedTo(order, user.id, now)) {
      return c.json({ error: "This job changed — check the new request" }, 409);
    }
    const requested =
      typeof shown === "string"
        ? answersRequest(order, user.id, shown, now)
        : shown === undefined && isOfferedTo(order, user.id, now);
    if (typeof shown === "string" && !requested) {
      return c.json({ error: "This request is no longer available" }, 409);
    }
    if (!requested && (isHeldForOtherRider(order, user.id, now) || !isOfferable(order))) {
      return c.json({ error: "This job is no longer available" }, 409);
    }
    if (!requested) {
      // The pool never shows this rider a job they declined or dropped; a
      // stale screen can't take it either.
      const { data: declined } = await supabaseAdmin
        .from("rider_order_declines")
        .select("order_id")
        .eq("order_id", id)
        .eq("rider_id", user.id)
        .maybeSingle();
      if (declined) return c.json({ error: "This job is no longer available" }, 409);
      if (order.type === "courier") {
        // Past its search window the request is being canceled (no_rider).
        if (isCourierSearchExpired(order, now)) return c.json({ error: "This job is no longer available" }, 409);
        if (!riderCanTake(order.vehicle_type, (await riderPosition(user.id)).vehicleType)) {
          return c.json({ error: "This delivery needs a motorcycle" }, 409);
        }
      }
      if (order.type === "ride") {
        // Past its search window the ride is being canceled (no_rider).
        if (isRideSearchExpired(order, now)) return c.json({ error: "This job is no longer available" }, 409);
        const problem = rideRiderProblem(order, {
          vehicleType: (await riderPosition(user.id)).vehicleType,
          gender: rideOf(order)?.female_rider_only ? await riderGender(user.id) : null,
        });
        if (problem === "vehicle") return c.json({ error: "This ride needs a motorcycle" }, 409);
        if (problem === "gender") return c.json({ error: "This passenger asked for a female rider" }, 409);
      }
    }
    if (!scheduled && (await currentJobRow(user.id))) {
      return c.json({ error: "Finish your current trip first" }, 400);
    }

    // Conditional update = atomic claim: only one rider wins an open order,
    // and only while the request is exactly as read.
    let patch: { delivery_mode?: "own" | "blink" };
    let claimed: Record<string, any> | null;
    if (requested) {
      // The store may have removed this driver since asking.
      if (order.offered_mode === "own" && !(await isActiveStoreDriver(order, user.id))) {
        await supabaseAdmin
          .from("orders")
          .update(CLEAR_OFFER)
          .eq("id", id)
          .eq("offered_rider_id", user.id)
          .eq("offered_at", order.offered_at)
          .is("rider_id", null);
        return c.json({ error: "This request is no longer available" }, 409);
      }
      const accept = acceptPatch(order, user.id, nowIso, { scheduled });
      if (!accept) return c.json({ error: "This request is no longer available" }, 409);
      patch = accept;
      // Withdrawn, re-sent or declined since the read → no row.
      const { data } = await sameAs(
        supabaseAdmin
          .from("orders")
          .update(accept)
          .eq("id", id)
          .is("rider_id", null)
          .eq("status", "searching")
          .eq("offered_rider_id", user.id)
          .eq("offered_at", order.offered_at)
          .eq("offered_mode", order.offered_mode)
          .is("offer_declined_at", null),
        "offered_driver_id",
        order.offered_driver_id
      )
        .select(ORDER_SELECT)
        .maybeSingle();
      claimed = data;
    } else {
      const claim = poolClaimPatch(order, user.id, nowIso, { scheduled });
      patch = claim;
      const open = supabaseAdmin
        .from("orders")
        .update(claim)
        .eq("id", id)
        .is("rider_id", null)
        .eq("status", "searching");
      // A store request written after the read wins: the request as read
      // (a declined / expired one, or none) must still be the one there.
      const { data } = await (
        order.offered_rider_id
          ? sameAs(open.eq("offered_rider_id", order.offered_rider_id), "offered_at", order.offered_at)
          : open.is("offered_rider_id", null)
      )
        .select(ORDER_SELECT)
        .maybeSingle();
      claimed = data;
    }
    if (!claimed) return c.json({ error: "This job is no longer available" }, 409);

    // A store's own driver delivers without a trip (no Blink commission).
    if (patch.delivery_mode !== "own") {
      try {
        await createTripForOrder(claimed, user.id);
      } catch (e) {
        // Roll the claim back so the order isn't stuck on this rider (the
        // request as read included), never reviving an order canceled meanwhile.
        await supabaseAdmin
          .from("orders")
          .update(claimRollback(order))
          .eq("id", id)
          .eq("rider_id", user.id)
          .eq("status", claimed.status);
        return c.json({ error: (e as Error).message }, 400);
      }
    }
    if (!(await claimStillHeld([id], user.id))) {
      return c.json({ error: "This job is no longer available" }, 409);
    }

    // On a job now: stores still waiting on this rider can pick someone else.
    // A booked scheduled job keeps the rider free until /start.
    if (!scheduled) await releaseRiderRequests(user.id, { keepOrderId: id });

    const ref = orderRef(id);
    // The store hears who's coming — whether it asked this rider or a Blink
    // rider took its order from the pool (its screen updates via realtime).
    const names = order.type === "merchant" ? await riderNames(user.id) : null;
    await Promise.all([
      order.type === "courier"
        ? notifyCourier(claimed as { id: string; customer_id: string }, { kind: "accepted", scheduled })
        : order.type === "ride"
          ? notifyRide(claimed as { id: string; customer_id: string }, { kind: "accepted", scheduled })
          : notifyCustomer(
              claimed.customer_id,
              { title: "Rider found", description: `A rider accepted your order ${ref}.` },
              { title: "Livreur trouvé", description: `Un livreur a accepté votre commande ${ref}.` },
              { title: "تم العثور على سائق", description: `قبل سائق طلبك ${ref}.` }
            ),
      names &&
        notifyStoreOwner(
          storeOwnerId(order),
          id,
          {
            title: `${names.en} accepted order ${ref}`,
            description: scheduled ? "They'll pick it up at the scheduled time." : "They're on the way to collect it.",
          },
          {
            title: `${names.fr} a accepté la commande ${ref}`,
            description: scheduled ? "Il la récupérera à l'heure prévue." : "Il arrive pour la récupérer.",
          },
          {
            title: `قبل ${names.ar} الطلب ${ref}`,
            description: scheduled ? "سيستلمه في الموعد المحدد." : "إنه في الطريق لاستلامه.",
          }
        ),
    ]);

    const [job] = await toJobs([claimed], { rider: await riderPosition(user.id) });
    return c.json({ job }, 200);
  }
);

// ─── POST /jobs/{id}/decline — skip an offer (never offered again) ───
// Declining a store's request also answers the store right away, so it can
// pick another rider instead of waiting out the TTL.
app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/decline",
    operationId: "declineRiderJob",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(declineJobSchema), required: false } },
    responses: { 200: json(OkSchema), 400: errorResponses[400] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json") ?? {};
    const now = Date.now();
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("id, status, rider_id, checkout_id, offered_rider_id, offered_at, offer_declined_at, store:stores(owner_id)")
      .eq("id", id)
      .maybeSingle();
    const { error } = await supabaseAdmin
      .from("rider_order_declines")
      .upsert({ order_id: id, rider_id: user.id, stage: "offer", reason: body.reason ?? null });
    if (error) return c.json({ error: error.message }, 400);

    // Declining names the request the rider saw; null = a pool job, which
    // never declines a store request that arrived meanwhile (older apps send
    // nothing: the open request, if any).
    const shown = body.request_expires_at;
    // A store's own-driver request for a whole checkout: declined on every member.
    if (order?.checkout_id) {
      const members = bundleMembers(await loadBundle(order.checkout_id));
      const answersAll =
        typeof shown === "string"
          ? bundleAnswersRequest(members, user.id, shown, now)
          : shown === undefined && bundleOfferedTo(members, user.id, now);
      if (answersAll) {
        const lead = leadOrder(members);
        const { data: declined } = await supabaseAdmin
          .from("orders")
          .update({ offer_declined_at: new Date(now).toISOString() })
          .eq("checkout_id", order.checkout_id)
          .eq("offered_rider_id", user.id)
          .eq("offered_at", lead.offered_at)
          .is("rider_id", null)
          .eq("status", "searching")
          .is("offer_declined_at", null)
          .select("id");
        if (declined?.length) {
          const [names, ref] = [await riderNames(user.id), orderRef(lead.id)];
          await notifyStoreOwner(
            storeOwnerId(order),
            lead.id,
            { title: `${names.en} declined order ${ref}`, description: "Choose another rider." },
            { title: `${names.fr} a refusé la commande ${ref}`, description: "Choisissez un autre livreur." },
            { title: `رفض ${names.ar} الطلب ${ref}`, description: "اختر سائقًا آخر." }
          );
        }
      }
      return c.json({ success: true }, 200);
    }
    const answers = order
      ? typeof shown === "string"
        ? answersRequest(order, user.id, shown, now)
        : shown === undefined && isOfferedTo(order, user.id, now)
      : false;
    if (order && answers) {
      // Only the request as read: one re-sent or accepted meanwhile stays as is.
      const { data: declined } = await supabaseAdmin
        .from("orders")
        .update({ offer_declined_at: new Date(now).toISOString() })
        .eq("id", id)
        .eq("offered_rider_id", user.id)
        .eq("offered_at", order.offered_at)
        .is("rider_id", null)
        .eq("status", "searching")
        .is("offer_declined_at", null)
        .select("id")
        .maybeSingle();
      if (declined) {
        const [names, ref] = [await riderNames(user.id), orderRef(id)];
        await notifyStoreOwner(
          storeOwnerId(order),
          id,
          { title: `${names.en} declined order ${ref}`, description: "Choose another rider." },
          { title: `${names.fr} a refusé la commande ${ref}`, description: "Choisissez un autre livreur." },
          { title: `رفض ${names.ar} الطلب ${ref}`, description: "اختر سائقًا آخر." }
        );
      }
    }
    return c.json({ success: true }, 200);
  }
);

// ─── POST /jobs/{id}/start — start a booked scheduled job ────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/start",
    operationId: "startRiderJob",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam },
    responses: { 200: json(RiderJobResponse), 400: errorResponses[400], 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    if (await currentJobRow(user.id)) return c.json({ error: "Finish your current trip first" }, 400);
    const { data } = await supabaseAdmin
      .from("orders")
      .update({ status: "heading_to_store" })
      .eq("id", id)
      .eq("rider_id", user.id)
      .eq("status", "searching")
      .select(ORDER_SELECT)
      .maybeSingle();
    if (!data) return c.json({ error: "Job not found" }, 404);
    // On a job now: stores still waiting on this rider can pick someone else.
    await releaseRiderRequests(user.id, { keepOrderId: id });
    if (data.type === "courier") await notifyCourier(data as { id: string; customer_id: string }, { kind: "started" });
    if (data.type === "ride") await notifyRide(data as { id: string; customer_id: string }, { kind: "started" });
    const [job] = await toJobs([data], { rider: await riderPosition(user.id) });
    return c.json({ job }, 200);
  }
);

// ─── POST /jobs/{id}/advance — arrived → picked up → delivered ───────
const NEXT: Record<string, { from: string[]; to: string }> = {
  arrived: { from: ["heading_to_store"], to: "pickup" },
  picked_up: { from: ["heading_to_store", "preparation", "pickup"], to: "on_the_way" },
  delivered: { from: ["on_the_way"], to: "delivered" },
};

/** A completed `trips` row → the summary the rider sees after delivery. */
function tripSummary(trip: Record<string, any>): z.infer<typeof TripSummarySchema> {
  return {
    trip_id: trip.id,
    display_id: trip.display_id,
    pickup_address: trip.pickup_address,
    destination_address: trip.dropoff_address,
    total_fare: Number(trip.estimated_payout),
    commission: Number(trip.estimated_payout) - Number(trip.net_payout),
    net_payout: Number(trip.net_payout),
    distance_km: Number(trip.distance_km),
    duration_minutes: trip.duration_minutes,
  };
}

/**
 * Complete a checkout's trip. It pays only what the delivered stores pay
 * (today that is every member: a store can't drop out once a rider holds the
 * checkout). The trip was created on the lead order at accept time, so it is
 * looked up across every order of the checkout.
 */
async function completeBundleTrip(checkoutOrderIds: string[], delivered: BundleRow[], riderId: string) {
  const fare = delivered.reduce((sum, o) => sum + Number(o.delivery_fee ?? 0), 0);
  const { data: trip } = await supabaseAdmin
    .from("trips")
    .update({ status: "completed", ...tripPayout(fare) })
    .in("order_id", checkoutOrderIds)
    .eq("rider_id", riderId)
    .eq("status", "upcoming")
    .select("*")
    .maybeSingle();
  return trip ? tripSummary(trip) : undefined;
}

// A stale step (the order moved on elsewhere, or a lost race) answers 409 so
// the rider app resyncs instead of showing an error; bad input stays 400.
app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/advance",
    operationId: "advanceRiderJob",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(advanceJobSchema), required: true } },
    responses: {
      200: json(AdvanceJobResponse),
      400: errorResponses[400],
      404: errorResponses[404],
      409: json(ErrorSchema, "Job changed"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { step, order_id } = c.req.valid("json");
    const move = NEXT[step];

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("id, status, customer_id, checkout_id, type, merchant_status, courier, ride, updated_at, destination_address")
      .eq("id", id)
      .eq("rider_id", user.id)
      .maybeSingle();
    if (!order) return c.json({ error: "Job not found" }, 404);

    // ─── Multi-store checkout: stops one by one, then one delivery ───
    if (order.checkout_id) {
      const checkoutId = order.checkout_id as string;
      const rows = await loadBundle(checkoutId);
      const members = riderMembers(rows, user.id);
      if (!members.length) return c.json({ error: "Job not found" }, 404);
      const now = new Date().toISOString();

      if (step === "delivered") {
        if (!canDeliverBundle(members)) {
          return c.json({ error: "Pick up every stop before confirming delivery" }, 400);
        }
        const { data: delivered, error: deliverError } = await supabaseAdmin
          .from("orders")
          .update({ status: "delivered", delivered_at: now })
          .in("id", members.map((m) => m.id))
          .eq("rider_id", user.id)
          .eq("status", "on_the_way")
          .select(ORDER_SELECT);
        if (deliverError) return c.json({ error: deliverError.message }, 400);
        if (!delivered?.length) return c.json({ error: "Job changed, try again" }, 409);
        const summary = await completeBundleTrip(rows.map((r) => r.id), delivered, user.id);
        const ref = orderRef(leadOrder(delivered).id);
        await notifyCustomer(
          order.customer_id,
          { title: "Delivered", description: `Order ${ref} has been delivered.` },
          { title: "Livrée", description: `La commande ${ref} a été livrée.` },
          { title: "تم التوصيل", description: `تم توصيل الطلب ${ref}.` }
        );
        const job = await toBundleJob(delivered, { rider: await riderPosition(user.id) });
        return c.json(summary ? { job, summary } : { job }, 200);
      }

      // Older rider builds don't send `order_id`: act on the current stop
      // (first one not yet collected, in route order).
      const stopId =
        order_id ??
        (await toBundleJob(members, { rider: await riderPosition(user.id) })).stops.find((s) => !s.picked_up)
          ?.order_id;
      const stop = members.find((m) => m.id === stopId);
      if (!stop) return c.json({ error: "Stop not found" }, 404);
      if (!move.from.includes(stop.status)) {
        return c.json({ error: `Can't mark ${step} while ${stop.status}` }, 409);
      }
      // A single conditional update on one member, so a retry is safe.
      const { data: moved, error } = await supabaseAdmin
        .from("orders")
        .update(move.to === "on_the_way" ? pickedUpPatch(stop, now) : { status: move.to })
        .eq("id", stop.id)
        .eq("rider_id", user.id)
        .eq("status", stop.status)
        .select("id")
        .maybeSingle();
      if (error) return c.json({ error: error.message }, 400);
      if (!moved) return c.json({ error: "Job changed, try again" }, 409);

      const fresh = riderMembers(await loadBundle(checkoutId), user.id);
      const ref = orderRef(leadOrder(fresh).id);
      if (step === "arrived") {
        const store = stop.store_name ?? "";
        await notifyCustomer(
          order.customer_id,
          { title: `Rider at ${store}`, description: `Your rider arrived at ${store} to collect part of order ${ref}.` },
          { title: `Livreur chez ${store}`, description: `Votre livreur est arrivé chez ${store} pour récupérer une partie de la commande ${ref}.` },
          { title: `السائق في ${store}`, description: `وصل سائقك إلى ${store} لاستلام جزء من الطلب ${ref}.` }
        );
      } else if (canDeliverBundle(fresh)) {
        // Last stop collected: the whole checkout is on its way.
        await notifyCustomer(
          order.customer_id,
          { title: "On the way", description: `Order ${ref} is on its way to you.` },
          { title: "En route", description: `La commande ${ref} est en route.` },
          { title: "في الطريق", description: `الطلب ${ref} في الطريق إليك.` }
        );
      }
      const job = await toBundleJob(fresh, { rider: await riderPosition(user.id) });
      return c.json({ job }, 200);
    }

    // ─── Single order ────────────────────────────────────────────────
    if (!move.from.includes(order.status)) {
      return c.json({ error: `Can't mark ${step} while ${order.status}` }, 409);
    }
    // A ride's passenger boards only after "I've arrived" (it starts the
    // passenger's waiting clock and tells them the rider is there).
    if (step === "picked_up" && order.type === "ride" && !rideCanPickUp(order.status)) {
      return c.json({ error: "Report your arrival at the pickup before the passenger boards" }, 409);
    }

    const now = new Date().toISOString();
    const courier = order.type === "courier" ? courierOf(order) : null;
    const isRide = order.type === "ride";
    const ride = isRide ? rideOf(order) : null;

    // ─── Courier with drop-offs left after this one: deliver this stop only ──
    if (step === "delivered" && courier && remainingDropOffs(courier) > 1) {
      const done = deliverCurrentDropOff(courier, now)!;
      // Conditional on the row as read, so a double tap can't skip a stop.
      const { data: updated, error } = await supabaseAdmin
        .from("orders")
        .update({ courier: done.courier })
        .eq("id", id)
        .eq("rider_id", user.id)
        .eq("status", "on_the_way")
        .eq("updated_at", order.updated_at)
        .select(ORDER_SELECT)
        .maybeSingle();
      if (error) return c.json({ error: error.message }, 400);
      if (!updated) return c.json({ error: "Job changed, try again" }, 409);
      await notifyCourier(order, {
        kind: "dropped_off",
        to: dropOffName(order, done.index),
        done: done.index + 1,
        total: courier.drop_offs.length,
      });
      const [job] = await toJobs([updated], { rider: await riderPosition(user.id) });
      return c.json({ job }, 200);
    }

    const patch: Record<string, unknown> =
      move.to === "on_the_way" ? pickedUpPatch(order, now) : { status: move.to };
    if (move.to === "delivered") patch.delivered_at = now;
    // The last drop-off of a courier route is delivered with the order.
    if (move.to === "delivered" && courier) {
      const done = deliverCurrentDropOff(courier, now);
      if (done) patch.courier = done.courier;
    }
    // A ride's "I've arrived" starts the passenger's waiting clock. Written
    // with the status, conditional on the status as read.
    if (move.to === "pickup" && ride) patch.ride = markRideArrived(ride, now);
    const { data: updated, error } = await supabaseAdmin
      .from("orders")
      .update(patch)
      .eq("id", id)
      .eq("rider_id", user.id)
      .eq("status", order.status)
      .select(ORDER_SELECT)
      .maybeSingle();
    if (error) return c.json({ error: error.message }, 400);
    if (!updated) return c.json({ error: "Job changed, try again" }, 409);

    const ref = orderRef(id);
    let summary: z.infer<typeof TripSummarySchema> | undefined;
    if (courier && step === "arrived") {
      await notifyCourier(order, { kind: "arrived" });
    } else if (courier && step === "picked_up") {
      await notifyCourier(order, { kind: "picked_up", to: dropOffName(order, 0) });
    } else if (isRide && step === "arrived") {
      await notifyRide(order, { kind: "arrived" });
    } else if (isRide && step === "picked_up") {
      await notifyRide(order, {
        kind: "picked_up",
        to: ride?.destination.label || ride?.destination.address || order.destination_address || "",
      });
    } else if (step === "arrived") {
      await notifyCustomer(
        order.customer_id,
        { title: "Rider at pickup", description: `Your rider arrived to collect order ${ref}.` },
        { title: "Livreur sur place", description: `Votre livreur est arrivé pour récupérer la commande ${ref}.` },
        { title: "السائق في نقطة الاستلام", description: `وصل سائقك لاستلام الطلب ${ref}.` }
      );
    } else if (step === "picked_up") {
      await notifyCustomer(
        order.customer_id,
        { title: "On the way", description: `Order ${ref} is on its way to you.` },
        { title: "En route", description: `La commande ${ref} est en route.` },
        { title: "في الطريق", description: `الطلب ${ref} في الطريق إليك.` }
      );
    } else {
      // Only this rider's open trip. An own-driver delivery has none, and a
      // trip another rider dropped on this order stays theirs (canceled, with
      // its penalty): completing it would credit them, and charge them Blink's
      // commission, for a delivery they never made.
      const { data: trip } = await supabaseAdmin
        .from("trips")
        .update({ status: "completed" })
        .eq("order_id", id)
        .eq("rider_id", user.id)
        .eq("status", "upcoming")
        .select("*")
        .maybeSingle();
      if (trip) summary = tripSummary(trip);
      if (courier) {
        await notifyCourier(order, { kind: "delivered", to: dropOffName(order, courier.drop_offs.length - 1) });
      } else if (isRide) {
        await notifyRide(order, { kind: "delivered" });
      } else {
        await notifyCustomer(
          order.customer_id,
          { title: "Delivered", description: `Order ${ref} has been delivered.` },
          { title: "Livrée", description: `La commande ${ref} a été livrée.` },
          { title: "تم التوصيل", description: `تم توصيل الطلب ${ref}.` }
        );
      }
    }

    const [job] = await toJobs([updated], { rider: await riderPosition(user.id) });
    return c.json(summary ? { job, summary } : { job }, 200);
  }
);

// ─── POST /jobs/{id}/cancel — drop an accepted job before pickup ─────
// The order goes back to `searching` for another rider; the trip is marked
// canceled with the cancellation penalty. Except a ride whose passenger never
// showed up (reason passenger_no_show, rider at the pickup for at least
// RIDE_NO_SHOW_WAIT_MS — else 400 no_show_too_early): that ride ends —
// canceled by the rider, no penalty, the coupon stays used.
/** A single order the rider may still drop: booked, or not yet picked up. */
const DROPPABLE = ["searching", "heading_to_store", "preparation", "pickup"];

app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/cancel",
    operationId: "cancelRiderJob",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(cancelJobSchema), required: true } },
    responses: {
      200: json(OkSchema),
      400: json(CancelRiderJobError, "Bad request (code no_show_too_early: wait seconds_remaining more)"),
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { reason } = c.req.valid("json");

    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("id, status, type, customer_id, checkout_id, ride, updated_at, store:stores(owner_id)")
      .eq("id", id)
      .eq("rider_id", user.id)
      .maybeSingle();
    if (!order) return c.json({ error: "Job not found" }, 404);

    // ─── Multi-store checkout: release every store's order together ──
    if (order.checkout_id) {
      const rows = await loadBundle(order.checkout_id);
      const members = riderMembers(rows, user.id);
      if (!members.length) return c.json({ error: "Job not found" }, 404);
      if (!canCancelBundle(members)) {
        return c.json({ error: "Part of the order is already on board — report an issue instead" }, 400);
      }
      const started = members.some((m) => m.status !== "searching");
      const ids = members.map((m) => m.id as string);

      const { data: released } = await supabaseAdmin
        .from("orders")
        // delivery_mode (and an own driver) go back to null. Shopper members never had one.
        .update({
          rider_id: null,
          rider_assigned_at: null,
          status: "searching",
          delivery_mode: null,
          store_driver_id: null,
          ...CLEAR_OFFER,
        })
        .in("id", ids)
        .eq("rider_id", user.id)
        // Never revive an order the customer canceled meanwhile.
        .in("status", ["heading_to_store", "preparation", "pickup"])
        .select("id");
      if (!released?.length) return c.json({ error: "Job changed, try again" }, 400);

      await Promise.all([
        // There is one trip per checkout, so the penalty is charged once.
        supabaseAdmin
          .from("trips")
          .update({
            status: "canceled",
            cancellation_reason: reason,
            penalty_amount: started ? POST_ACCEPT_PENALTY : null,
          })
          .in("order_id", rows.map((r) => r.id))
          .eq("rider_id", user.id)
          .eq("status", "upcoming"),
        // This checkout is never offered to this rider again.
        supabaseAdmin
          .from("rider_order_declines")
          .upsert(ids.map((orderId) => ({ order_id: orderId, rider_id: user.id, stage: "post_accept", reason }))),
      ]);

      const ref = orderRef(leadOrder(members).id);
      await notifyCustomer(
        order.customer_id,
        { title: "Finding a new rider", description: `Your rider canceled order ${ref}. We're finding another one.` },
        { title: "Recherche d'un nouveau livreur", description: `Votre livreur a annulé la commande ${ref}. Nous en cherchons un autre.` },
        { title: "البحث عن سائق جديد", description: `ألغى السائق الطلب ${ref}. نبحث عن سائق آخر.` }
      );
      return c.json({ success: true }, 200);
    }

    // ─── Ride: the passenger didn't show up at the pickup → it ends here ──
    if (isPassengerNoShow(order, reason)) {
      const tooEarly = (leftMs: number) =>
        c.json(
          {
            error: "It's too early to report a no-show: wait for the passenger a little longer",
            code: NO_SHOW_TOO_EARLY,
            seconds_remaining: Math.ceil(leftMs / 1000),
          },
          400
        );
      // At the pickup without an arrival time (the "I've arrived" write never
      // stamped it): start the waiting clock now, so this refusal isn't
      // repeated forever. Conditional on the row as read, like an advance.
      const ride = rideOf(order);
      const started = startNoShowClock(ride, new Date().toISOString());
      if (started) {
        const { data: stamped } = await supabaseAdmin
          .from("orders")
          .update({ ride: started })
          .eq("id", id)
          .eq("rider_id", user.id)
          .eq("status", "pickup")
          .eq("updated_at", order.updated_at)
          .select("id")
          .maybeSingle();
        if (!stamped) return c.json({ error: "Job changed, try again" }, 400);
        return tooEarly(RIDE_NO_SHOW_WAIT_MS);
      }
      // Only after waiting RIDE_NO_SHOW_WAIT_MS at the pickup (server clock).
      const leftMs = noShowWaitLeftMs(ride);
      if (leftMs > 0) return tooEarly(leftMs);
      const { data: ended } = await supabaseAdmin
        .from("orders")
        .update({
          status: "canceled",
          canceled_at: new Date().toISOString(),
          canceled_by: "rider",
          cancel_reason: PASSENGER_NO_SHOW_REASON,
          ...CLEAR_OFFER,
        })
        .eq("id", id)
        .eq("rider_id", user.id)
        // Still waiting at the pickup: not a ride the customer canceled or that left meanwhile.
        .eq("status", "pickup")
        .select("id")
        .maybeSingle();
      if (!ended) return c.json({ error: "Job changed, try again" }, 400);
      // The rider waited for nothing: the trip closes without a penalty.
      await supabaseAdmin
        .from("trips")
        .update({ status: "canceled", cancellation_reason: PASSENGER_NO_SHOW_REASON, penalty_amount: null })
        .eq("order_id", id)
        .eq("rider_id", user.id)
        .eq("status", "upcoming");
      await notifyRide(order as { id: string; customer_id: string }, { kind: "canceled_by_rider" });
      return c.json({ success: true }, 200);
    }
    if (reason === PASSENGER_NO_SHOW_REASON && order.type === "ride") {
      return c.json({ error: "Report a no-show once you've arrived at the pickup" }, 400);
    }

    if (!DROPPABLE.includes(order.status)) {
      return c.json(
        {
          error:
            order.type === "ride"
              ? "The passenger is already on board — report an issue instead"
              : "The parcel is already on board — report an issue instead",
        },
        400
      );
    }
    const started = order.status !== "searching";
    const ride = order.type === "ride" ? rideOf(order) : null;

    const { data: released } = await supabaseAdmin
      .from("orders")
      .update({
        rider_id: null,
        rider_assigned_at: null,
        status: "searching",
        // A store order is the store's to place again: Blink pool or a new
        // request, with no driver of its own still attached.
        ...(order.type === "merchant" ? { delivery_mode: null, store_driver_id: null } : {}),
        // A courier or ride is live again from now: its search window (offers +
        // no_rider expiry, src/lib/courier.ts / ride.ts) restarts instead of
        // running out.
        ...(order.type === "courier" || order.type === "ride" ? { accepted_at: new Date().toISOString() } : {}),
        // The next rider hasn't arrived yet.
        ...(ride ? { ride: { ...ride, arrived_at: null } } : {}),
        ...CLEAR_OFFER,
      })
      .eq("id", id)
      .eq("rider_id", user.id)
      // Never revive an order the customer canceled meanwhile, nor drop one now on board.
      .in("status", DROPPABLE)
      .select("id")
      .maybeSingle();
    if (!released) return c.json({ error: "Job changed, try again" }, 400);

    await Promise.all([
      // This claim's open trip only. An own-driver delivery has none, and an
      // earlier canceled trip of this rider on this order keeps its penalty.
      supabaseAdmin
        .from("trips")
        .update({
          status: "canceled",
          cancellation_reason: reason,
          penalty_amount: started ? POST_ACCEPT_PENALTY : null,
        })
        .eq("order_id", id)
        .eq("rider_id", user.id)
        .eq("status", "upcoming"),
      supabaseAdmin
        .from("rider_order_declines")
        .upsert({ order_id: id, rider_id: user.id, stage: "post_accept", reason }),
    ]);

    const ref = orderRef(id);
    // The store sees its order back in "searching" and may ask another rider.
    const names = order.type === "merchant" ? await riderNames(user.id) : null;
    await Promise.all([
      order.type === "courier"
        ? notifyCourier(order as { id: string; customer_id: string }, { kind: "rider_canceled" })
        : order.type === "ride"
          ? notifyRide(order as { id: string; customer_id: string }, { kind: "rider_canceled" })
          : notifyCustomer(
              order.customer_id,
              { title: "Finding a new rider", description: `Your rider canceled order ${ref}. We're finding another one.` },
              { title: "Recherche d'un nouveau livreur", description: `Votre livreur a annulé la commande ${ref}. Nous en cherchons un autre.` },
              { title: "البحث عن سائق جديد", description: `ألغى السائق الطلب ${ref}. نبحث عن سائق آخر.` }
            ),
      names &&
        notifyStoreOwner(
          storeOwnerId(order),
          id,
          { title: `${names.en} dropped order ${ref}`, description: "It's back to searching for a rider." },
          { title: `${names.fr} a abandonné la commande ${ref}`, description: "La recherche d'un livreur reprend." },
          { title: `تخلّى ${names.ar} عن الطلب ${ref}`, description: "عاد الطلب إلى البحث عن سائق." }
        ),
    ]);
    return c.json({ success: true }, 200);
  }
);

// ─── POST /jobs/{id}/rate-customer — rider rates the customer ────────
app.openapi(
  createRoute({
    method: "post",
    path: "/jobs/{id}/rate-customer",
    operationId: "rateRiderJobCustomer",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(rateCustomerSchema), required: true } },
    responses: { 200: json(OkSchema), 404: errorResponses[404] },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { rating } = c.req.valid("json");
    const { data } = await supabaseAdmin
      .from("trips")
      .update({ customer_rating: rating })
      .eq("order_id", id)
      .eq("rider_id", user.id)
      .eq("status", "completed")
      .select("id")
      .maybeSingle();
    if (!data) return c.json({ error: "Trip not found" }, 404);
    return c.json({ success: true }, 200);
  }
);

export default app;
