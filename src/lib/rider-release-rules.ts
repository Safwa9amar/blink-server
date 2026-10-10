// Returning a de-approved rider's booked jobs to the pool, kept pure so it's
// unit-testable without a database (see rider-release-rules.test.ts);
// ./rider-release.ts loads the rows and writes the result. It mirrors the
// rider's own drop (POST /riders/jobs/{id}/cancel) without the penalty or the
// decline record: the rider didn't cancel, staff revoked their approval.
import { courierHref } from "./courier-copy";
import { rideHref } from "./ride-copy";
import { CLEAR_OFFER } from "./rider-offer";

type Row = Record<string, any>;
type Copy = { title: string; description: string };

/** trips.cancellation_reason (free text) of a booked trip released this way: no penalty. */
export const RIDER_DEAPPROVED_REASON = "rider_deapproved";

/**
 * The rider's booked jobs among the orders they hold: single orders still
 * `searching` (accepted for later, not started), and multi-store checkouts
 * whose every held member still is. A checkout with a stop under way, like
 * any single order past `searching`, is the current job: the rider may finish it.
 */
export function bookedJobs(held: Row[]): { singles: Row[]; checkouts: Row[][] } {
  const singles = held.filter((o) => !o.checkout_id && o.status === "searching");
  const byCheckout = new Map<string, Row[]>();
  for (const o of held) {
    if (!o.checkout_id) continue;
    const members = byCheckout.get(o.checkout_id);
    if (members) members.push(o);
    else byCheckout.set(o.checkout_id, [o]);
  }
  const checkouts = [...byCheckout.values()].filter((members) => members.every((o) => o.status === "searching"));
  return { singles, checkouts };
}

/**
 * A booked single order back in the pool — the rider cancel's patch, and the
 * status stays `searching`. A booked ride never reached its pickup, so its
 * `ride.arrived_at` is already null.
 */
export function releasePatch(o: Row, nowIso: string) {
  return {
    rider_id: null,
    rider_assigned_at: null,
    // A store order is the store's to place again: Blink pool or a new
    // request, with no driver of its own still attached.
    ...(o.type === "merchant" ? { delivery_mode: null, store_driver_id: null } : {}),
    // A courier or ride is live again from now: its search window restarts
    // instead of running out.
    ...(o.type === "courier" || o.type === "ride" ? { accepted_at: nowIso } : {}),
    ...CLEAR_OFFER,
  };
}

/** The same for every member of a booked checkout (shopper members never had a delivery mode). */
export const CHECKOUT_RELEASE_PATCH = {
  rider_id: null,
  rider_assigned_at: null,
  delivery_mode: null,
  store_driver_id: null,
  ...CLEAR_OFFER,
};

/**
 * "Finding a new rider" to the customer, without blaming the rider. Courier
 * and ride events keep their own type and open the tracking screen, like
 * their other notifications (./courier-copy.ts, ./ride-copy.ts).
 */
export function releaseNotice(
  o: Row,
  ref: string
): { type: "order" | "courier" | "ride"; href?: string; en: Copy; fr: Copy; ar: Copy } {
  if (o.type === "courier") {
    return {
      type: "courier",
      href: courierHref(o.id),
      en: { title: "Finding a new rider", description: `Your rider can't take parcel delivery ${ref} anymore. We're finding another one.` },
      fr: { title: "Recherche d'un nouveau livreur", description: `Votre livreur ne peut plus assurer la livraison ${ref}. Nous en cherchons un autre.` },
      ar: { title: "البحث عن سائق جديد", description: `لم يعد السائق قادرًا على توصيل الطرد ${ref}. نبحث عن سائق آخر.` },
    };
  }
  if (o.type === "ride") {
    return {
      type: "ride",
      href: rideHref(o.id),
      en: { title: "Finding a new rider", description: `Your rider can't take ride ${ref} anymore. We're finding another one.` },
      fr: { title: "Recherche d'un nouveau chauffeur", description: `Votre chauffeur ne peut plus assurer la course ${ref}. Nous en cherchons un autre.` },
      ar: { title: "البحث عن سائق جديد", description: `لم يعد السائق قادرًا على تولي الرحلة ${ref}. نبحث عن سائق آخر.` },
    };
  }
  return {
    type: "order",
    en: { title: "Finding a new rider", description: `Your rider can't take order ${ref} anymore. We're finding another one.` },
    fr: { title: "Recherche d'un nouveau livreur", description: `Votre livreur ne peut plus prendre la commande ${ref}. Nous en cherchons un autre.` },
    ar: { title: "البحث عن سائق جديد", description: `لم يعد السائق قادرًا على تولي الطلب ${ref}. نبحث عن سائق آخر.` },
  };
}

/** The store of a released single order sees it searching again and may ask another rider. */
export function storeReleaseNotice(names: { en: string; fr: string; ar: string }, ref: string) {
  return {
    en: { title: `${names.en} can't take order ${ref} anymore`, description: "It's back to searching for a rider." },
    fr: { title: `${names.fr} ne peut plus prendre la commande ${ref}`, description: "La recherche d'un livreur reprend." },
    ar: { title: `لم يعد ${names.ar} قادرًا على تولي الطلب ${ref}`, description: "عاد الطلب إلى البحث عن سائق." },
  };
}
