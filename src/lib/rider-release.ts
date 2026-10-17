// Staff revoked a rider's approval (src/routes/riders/admin-review.ts): the
// jobs they booked for later and haven't started go back to the pool, so they
// can't start them hours later (POST /riders/jobs/{id}/start is gated too).
// Their current in-progress job stays theirs to finish. Rules, copy and
// patches: ./rider-release-rules.ts.
import { orderRef } from "../routes/merchant/shared";
import { leadOrder } from "./bundle";
import { IN_DELIVERY, notifyStoreOwner, riderNames } from "./dispatch";
import { createNotification } from "./notifications";
import {
  bookedJobs,
  CHECKOUT_RELEASE_PATCH,
  releaseNotice,
  releasePatch,
  RIDER_DEAPPROVED_REASON,
  storeReleaseNotice,
} from "./rider-release-rules";
import { supabaseAdmin } from "./supabase";

type Row = Record<string, any>;

/**
 * One booked job (a single order, or every member of a checkout) back to
 * `searching` with nobody on it. Conditional on the rider and `searching`, so
 * an order started or canceled meanwhile is left alone. Returns what was released.
 */
async function releaseJob(riderId: string, members: Row[], patch: Record<string, unknown>) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .update(patch)
    .in("id", members.map((o) => o.id))
    .eq("rider_id", riderId)
    .eq("status", "searching")
    .select("id");
  if (error) {
    console.error(`[riders] releasing booked job ${members[0].id} of rider ${riderId} failed:`, error.message);
    return [];
  }
  const ids = new Set((data ?? []).map((o) => o.id as string));
  return members.filter((o) => ids.has(o.id));
}

/**
 * Return a rider's booked, not-started jobs to the pool without a penalty:
 * their open trips close as `rider_deapproved`, each customer hears once per
 * order / checkout, and a store hears about its single order. Runs after the
 * review is written, so it never throws (errors are logged).
 */
export async function releaseBookedJobs(riderId: string): Promise<void> {
  try {
    // Every order the rider holds: a checkout with a member under way is their current job.
    const { data: held, error } = await supabaseAdmin
      .from("orders")
      .select("id, status, type, customer_id, checkout_id, subtotal, store:stores(owner_id)")
      .eq("rider_id", riderId)
      .in("status", ["searching", ...IN_DELIVERY]);
    if (error) throw new Error(error.message);
    const { singles, checkouts } = bookedJobs(held ?? []);
    if (!singles.length && !checkouts.length) return;

    const nowIso = new Date().toISOString();
    // Each job on its own: one that fails or moved on doesn't hold back the others.
    const [releasedSingles, releasedCheckouts] = await Promise.all([
      Promise.all(singles.map((o) => releaseJob(riderId, [o], releasePatch(o, nowIso)))),
      Promise.all(checkouts.map((members) => releaseJob(riderId, members, CHECKOUT_RELEASE_PATCH))),
    ]);
    const singlesOut = releasedSingles.flat();
    const checkoutsOut = releasedCheckouts.filter((members) => members.length);
    const releasedIds = [...singlesOut, ...checkoutsOut.flat()].map((o) => o.id as string);
    if (!releasedIds.length) return;
    // Pushing the jobs to nearby riders (pushNewOffer) can be added when src/lib/offer-push.ts lands.

    // Their open trips (one per checkout, on its lead order). An own-driver delivery has none.
    const { error: tripsErr } = await supabaseAdmin
      .from("trips")
      .update({ status: "canceled", cancellation_reason: RIDER_DEAPPROVED_REASON, penalty_amount: null })
      .in("order_id", releasedIds)
      .eq("rider_id", riderId)
      .eq("status", "upcoming");
    if (tripsErr) console.error(`[riders] closing booked trips of rider ${riderId} failed:`, tripsErr.message);

    const names = singlesOut.some((o) => o.type === "merchant") ? await riderNames(riderId).catch(() => null) : null;
    const tellCustomer = (o: Row, ref: string) => {
      const n = releaseNotice(o, ref);
      return createNotification({
        userId: o.customer_id,
        role: "customer",
        type: n.type,
        ...n.en,
        contentFr: n.fr,
        contentAr: n.ar,
        ...(n.href ? { href: n.href } : {}),
      }).catch(() => null);
    };
    await Promise.all([
      ...singlesOut.flatMap((o) => {
        const ref = orderRef(o.id);
        const store = names && o.type === "merchant" ? storeReleaseNotice(names, ref) : null;
        const ownerId = (o.store as { owner_id?: string | null } | null)?.owner_id;
        return [
          tellCustomer(o, ref),
          store && notifyStoreOwner(ownerId, o.id, store.en, store.fr, store.ar),
        ];
      }),
      // One notice per checkout, named by its lead order.
      ...checkoutsOut.map((members) => {
        const lead = leadOrder(members);
        return tellCustomer(lead, orderRef(lead.id));
      }),
    ]);
  } catch (e) {
    console.error(`[riders] releasing booked jobs of rider ${riderId} failed:`, (e as Error).message);
  }
}
