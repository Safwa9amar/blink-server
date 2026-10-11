// Merchant notification copy for a staff store review
// (PATCH /merchant/admin/stores/{id}/status), in en / fr / ar, plus the app
// screen it opens. Sent as type "alert" with `payload.kind` = the decision
// kind (store_approved | store_rejected | store_deactivated) — the store
// counterpart of the catalog decisions in catalog-review-copy.ts.

type Copy = { title: string; description: string };
export type StoreReviewStatus = "active" | "inactive" | "under_review";
export type StoreReviewKind = "store_approved" | "store_rejected" | "store_deactivated";
export type StoreReviewCopy = { kind: StoreReviewKind; en: Copy; fr: Copy; ar: Copy };

/** The merchant app's page for this store. */
export const storeReviewHref = (storeId: string) => `/(merchant)/profile/my-stores/${storeId}`;

/**
 * Which decision a status change is, or null when there's nothing to tell
 * (no change, or the store only went back to review). `from` is the status
 * before the update: a store leaving review (or a rejected one) is approved,
 * a store in review turned off is rejected, a live one turned off is deactivated.
 */
export function storeReviewKind(input: { from: StoreReviewStatus; to: StoreReviewStatus }): StoreReviewKind | null {
  const { from, to } = input;
  if (from === to || to === "under_review") return null;
  if (to === "active") return "store_approved";
  return from === "under_review" ? "store_rejected" : "store_deactivated";
}

/** Append the staff note (when there is one) to each language's description. */
function withNote(copy: Omit<StoreReviewCopy, "kind">, note?: string | null): Omit<StoreReviewCopy, "kind"> {
  const n = note?.trim();
  if (!n) return copy;
  return {
    en: { ...copy.en, description: `${copy.en.description} Note: ${n}` },
    fr: { ...copy.fr, description: `${copy.fr.description} Note : ${n}` },
    ar: { ...copy.ar, description: `${copy.ar.description} ملاحظة: ${n}` },
  };
}

/**
 * What to tell the store's owner after a review, or null when there's nothing
 * to tell (see storeReviewKind). A rejection / deactivation carries the staff
 * note; an approval never does (it clears the note).
 */
export function storeReviewCopy(input: {
  name: string;
  from: StoreReviewStatus;
  to: StoreReviewStatus;
  note?: string | null;
}): StoreReviewCopy | null {
  const kind = storeReviewKind(input);
  const { name, note } = input;

  switch (kind) {
    case null:
      return null;
    case "store_approved":
      return {
        kind,
        en: { title: "Store approved", description: `${name} is verified — customers can now find it and order.` },
        fr: {
          title: "Boutique approuvée",
          description: `${name} est vérifiée — les clients peuvent maintenant la trouver et commander.`,
        },
        ar: {
          title: "تمت الموافقة على المتجر",
          description: `تم التحقق من ${name} — يمكن للزبائن الآن العثور عليه والطلب منه.`,
        },
      };
    case "store_rejected":
      return {
        kind,
        ...withNote(
          {
            en: {
              title: "Store not approved",
              description: `${name} could not be verified. Check its details and documents, then resubmit it for review.`,
            },
            fr: {
              title: "Boutique refusée",
              description: `${name} n'a pas pu être vérifiée. Vérifiez ses informations et documents, puis renvoyez-la en vérification.`,
            },
            ar: {
              title: "لم تتم الموافقة على المتجر",
              description: `تعذر التحقق من ${name}. تحقق من بياناته ووثائقه ثم أعد إرساله للمراجعة.`,
            },
          },
          note
        ),
      };
    case "store_deactivated":
      return {
        kind,
        ...withNote(
          {
            en: {
              title: "Store deactivated",
              description: `${name} was taken offline by Blink and is no longer visible to customers. Fix the issue, then resubmit it for review.`,
            },
            fr: {
              title: "Boutique désactivée",
              description: `${name} a été retirée par Blink et n'est plus visible par les clients. Corrigez le problème, puis renvoyez-la en vérification.`,
            },
            ar: {
              title: "تم إيقاف المتجر",
              description: `أوقفت Blink المتجر ${name} ولم يعد ظاهرًا للزبائن. أصلح المشكلة ثم أعد إرساله للمراجعة.`,
            },
          },
          note
        ),
      };
  }
}
