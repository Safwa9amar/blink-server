/**
 * "New job near you" push for riders whose app is in the background.
 *
 * The rider app does not poll for offers: with the app open, a rider hears
 * pool changes over the socket (`riders:offers`, see the order realtime
 * trigger) and refetches `GET /riders/jobs/offer`. This push reaches the
 * riders the socket can't (app in the background or closed). It follows the
 * same pool rules as `GET /riders/jobs/offer`; best effort, never throws.
 *
 * Call it after any write that can put an order into the pool (creation,
 * a store accepting or handing over to a shopper, a rider releasing a job).
 * It checks offerability itself, so a call for an order that isn't in the
 * pool (yet) is a no-op.
 */
import { bundleMembers, isBundleOfferable } from "./bundle";
import {
  IN_DELIVERY,
  isFreshOffer,
  isOfferable,
  OFFER_RADIUS_KM,
  ORDER_SELECT,
  pickupOf,
} from "./dispatch";
import { pickOfferRecipients, ridersNear, type OfferPushRider } from "./offer-recipients";
import { sendPushToTokens } from "./push";
import { isRideSearchExpired, rideOf } from "./ride";
import { isHeld } from "./rider-offer";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

/** One push per job in this window (a burst of writes is one pool entry). */
const OFFER_PUSH_DEDUPE_MS = 5 * 60 * 1000;
/** Nearby riders checked for declines / busy jobs (keeps the id lists short). */
const NEAR_CANDIDATES = 60;
const pushedAt = new Map<string, number>();

/** The job a rider would be offered for this order: its whole checkout, or the order alone. */
async function offeredJob(orderId: string, now: number): Promise<Row[] | null> {
  const { data: order } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.rider_id || order.status !== "searching") return null;

  if (order.checkout_id) {
    const { data: rows } = await supabaseAdmin
      .from("orders")
      .select(ORDER_SELECT)
      .eq("checkout_id", order.checkout_id);
    if (!rows?.length || !isBundleOfferable(rows)) return null;
    const members = bundleMembers(rows);
    return members.some((m) => isHeld(m, now)) ? null : members;
  }

  // An order held for a store's request was pushed to that rider already.
  if (!isOfferable(order) || !isFreshOffer(order, now) || isHeld(order, now)) return null;
  if (order.type === "ride" && isRideSearchExpired(order, now)) return null;
  return [order];
}

const JOB_TITLE: Record<string, string> = {
  courier: "New parcel delivery near you",
  ride: "New ride request near you",
};

/**
 * Push the job this order belongs to, if it's in the pool, to the nearest
 * riders who can take it. `exclude`: a rider who just released this job.
 */
export async function pushNewOffer(
  orderId: string,
  opts: { exclude?: string | null; now?: number } = {}
): Promise<void> {
  const now = opts.now ?? Date.now();
  try {
    const members = await offeredJob(orderId, now);
    if (!members) return;
    const lead = members[0];
    const key = lead.checkout_id ?? lead.id;
    for (const [k, at] of pushedAt) if (now - at > OFFER_PUSH_DEDUPE_MS) pushedAt.delete(k);
    if (pushedAt.has(key)) return;
    pushedAt.set(key, now);

    const { data: profiles } = await supabaseAdmin
      .from("rider_profiles")
      .select("user_id, latitude, longitude, vehicle_type")
      .eq("is_available", true)
      .not("latitude", "is", null)
      .not("longitude", "is", null);
    const riders: OfferPushRider[] = (profiles ?? []).map((p) => ({
      id: p.user_id as string,
      lat: p.latitude as number | null,
      lng: p.longitude as number | null,
      vehicleType: (p.vehicle_type as string | null) ?? null,
    }));
    const near = ridersNear(members.map(pickupOf), riders, OFFER_RADIUS_KM, NEAR_CANDIDATES);
    if (!near.length) return;

    const ids = near.map((r) => r.id);
    const femaleOnly = members.length === 1 && lead.type === "ride" && !!rideOf(lead)?.female_rider_only;
    const [{ data: declined }, { data: busy }, { data: genders }] = await Promise.all([
      supabaseAdmin
        .from("rider_order_declines")
        .select("rider_id")
        .in("order_id", members.map((m) => m.id))
        .in("rider_id", ids),
      supabaseAdmin.from("orders").select("rider_id").in("rider_id", ids).in("status", IN_DELIVERY),
      femaleOnly
        ? supabaseAdmin.from("users").select("id, gender").in("id", ids)
        : Promise.resolve({ data: [] as Row[] }),
    ]);

    const skip = new Set((declined ?? []).map((d) => d.rider_id as string));
    if (opts.exclude) skip.add(opts.exclude);
    const recipients = pickOfferRecipients({
      members,
      near,
      skip,
      busy: new Set((busy ?? []).map((b) => b.rider_id as string)),
      genders: new Map((genders ?? []).map((g) => [g.id as string, (g.gender as string | null) ?? null])),
    });
    if (!recipients.length) return;

    const { data: tokens } = await supabaseAdmin
      .from("device_tokens")
      .select("token")
      .in("user_id", recipients);
    // Ephemeral, so no in-app feed row: the job is gone once someone takes it.
    await sendPushToTokens(
      (tokens ?? []).map((t) => t.token as string),
      {
        title: JOB_TITLE[members.length === 1 ? lead.type : "merchant"] ?? "New delivery near you",
        body: "Open Blink to see it before another rider takes it.",
        // The app hides this banner while open (the request sheet shows instead).
        data: { type: "job_offer", href: "/(rider)" },
      }
    );
  } catch (err) {
    console.error("[offer-push]", err);
  }
}
