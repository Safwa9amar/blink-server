// Merchant notifications for staff catalog decisions (products, price
// suggestions, packs), in en / fr / ar, plus the app screen each one opens.
// Sent as type "alert" with `payload.kind` = the event kind, which the
// merchant app's notification detail screen switches on
// (components/merchant/notifications/notification-targets.ts):
// `product_rejected` / `pricing_flagged` predate this file and keep their
// names; `product_approved`, `price_accepted`, `pack_approved`,
// `pack_rejected` and `pack_deactivated` are new.

type Copy = { title: string; description: string };
export type CatalogReviewCopy = { en: Copy; fr: Copy; ar: Copy };

/** The merchant app's product edit screen. */
export const merchantProductHref = (productId: string) => `/(merchant)/my-store/products/${productId}`;
/** The merchant app's price screen for one product. */
export const merchantPricingHref = (productId: string) => `/(merchant)/my-store/pricing/${productId}`;
/** The merchant app's pack screen. */
export const merchantPackHref = (packId: string) => `/(merchant)/my-store/packs/${packId}`;

export type CatalogReviewEvent =
  | { kind: "product_approved"; product_id: string; product: string; store: string }
  | { kind: "product_rejected"; product_id: string; product: string; store: string; note?: string | null }
  | { kind: "price_accepted"; product_id: string; product: string; price: number }
  | {
      kind: "pricing_flagged";
      product_id: string;
      product: string;
      /** The declined suggestion. */
      suggested: number | null;
      /** The price that stays live. */
      price: number;
      note?: string | null;
    }
  | { kind: "pack_approved"; pack_id: string; pack: string; store: string }
  | { kind: "pack_rejected"; pack_id: string; pack: string; store: string; note?: string | null }
  | { kind: "pack_deactivated"; pack_id: string; pack: string; store: string; note?: string | null };

export type CatalogReviewKind = CatalogReviewEvent["kind"];

/** 1500 → "1500", 99.5 → "99.5" (at most 2 decimals). */
export const money = (n: number) => String(Math.round(Number(n) * 100) / 100);

/** Append the staff note (when there is one) to each language's description. */
function withNote(copy: CatalogReviewCopy, note?: string | null): CatalogReviewCopy {
  const n = note?.trim();
  if (!n) return copy;
  return {
    en: { ...copy.en, description: `${copy.en.description} Note: ${n}` },
    fr: { ...copy.fr, description: `${copy.fr.description} Note : ${n}` },
    ar: { ...copy.ar, description: `${copy.ar.description} ملاحظة: ${n}` },
  };
}

export function catalogReviewCopy(e: CatalogReviewEvent): CatalogReviewCopy {
  switch (e.kind) {
    case "product_approved":
      return {
        en: { title: "Product approved", description: `${e.product} is now live at ${e.store}.` },
        fr: { title: "Produit approuvé", description: `${e.product} est maintenant en ligne chez ${e.store}.` },
        ar: { title: "تمت الموافقة على المنتج", description: `أصبح ${e.product} متاحًا الآن في ${e.store}.` },
      };
    case "product_rejected":
      return withNote(
        {
          en: {
            title: "Product not approved",
            description: `${e.product} at ${e.store} wasn't approved. Check its details and photos, then save it to send it again.`,
          },
          fr: {
            title: "Produit non approuvé",
            description: `${e.product} chez ${e.store} n'a pas été approuvé. Vérifiez ses informations et ses photos, puis enregistrez-le pour le renvoyer.`,
          },
          ar: {
            title: "لم تتم الموافقة على المنتج",
            description: `لم تتم الموافقة على ${e.product} في ${e.store}. تحقق من بياناته وصوره ثم احفظه لإعادة إرساله.`,
          },
        },
        e.note
      );
    case "price_accepted":
      return {
        en: { title: "New price approved", description: `${e.product} now sells at ${money(e.price)} Da.` },
        fr: { title: "Nouveau prix approuvé", description: `${e.product} est maintenant vendu à ${money(e.price)} Da.` },
        ar: { title: "تمت الموافقة على السعر الجديد", description: `يُباع ${e.product} الآن بسعر ${money(e.price)} دج.` },
      };
    case "pricing_flagged": {
      const s = e.suggested != null ? money(e.suggested) : null;
      return withNote(
        {
          en: {
            title: "Item pricing flagged",
            description: `${e.product}: your suggested price${s ? ` ${s} Da` : ""} was declined. It stays at ${money(e.price)} Da.`,
          },
          fr: {
            title: "Prix signalé",
            description: `${e.product} : votre prix proposé${s ? ` ${s} Da` : ""} a été refusé. Il reste à ${money(e.price)} Da.`,
          },
          ar: {
            title: "تم الإبلاغ عن السعر",
            description: `${e.product}: تم رفض السعر المقترح${s ? ` ${s} دج` : ""}. يبقى ${money(e.price)} دج.`,
          },
        },
        e.note
      );
    }
    case "pack_approved":
      return {
        en: { title: "Pack approved", description: `${e.pack} at ${e.store} is approved and now live.` },
        fr: { title: "Pack approuvé", description: `${e.pack} chez ${e.store} est approuvé et maintenant en ligne.` },
        ar: { title: "تمت الموافقة على الباقة", description: `تمت الموافقة على ${e.pack} في ${e.store} وأصبحت متاحة الآن.` },
      };
    case "pack_rejected":
      return withNote(
        {
          en: {
            title: "Pack not approved",
            description: `${e.pack} at ${e.store} wasn't approved. Edit it and turn it on again to resubmit.`,
          },
          fr: {
            title: "Pack non approuvé",
            description: `${e.pack} chez ${e.store} n'a pas été approuvé. Modifiez-le et réactivez-le pour le renvoyer.`,
          },
          ar: {
            title: "لم تتم الموافقة على الباقة",
            description: `لم تتم الموافقة على ${e.pack} في ${e.store}. عدّلها ثم فعّلها مجددًا لإعادة إرسالها.`,
          },
        },
        e.note
      );
    case "pack_deactivated":
      return withNote(
        {
          en: { title: "Pack deactivated", description: `${e.pack} at ${e.store} was taken offline by Blink.` },
          fr: { title: "Pack désactivé", description: `${e.pack} chez ${e.store} a été retiré par Blink.` },
          ar: { title: "تم إيقاف الباقة", description: `أوقفت Blink الباقة ${e.pack} في ${e.store}.` },
        },
        e.note
      );
  }
}

/** The screen a catalog decision opens (push deep link). */
export function catalogReviewHref(e: CatalogReviewEvent): string {
  switch (e.kind) {
    case "product_approved":
    case "product_rejected":
      return merchantProductHref(e.product_id);
    case "price_accepted":
    case "pricing_flagged":
      return merchantPricingHref(e.product_id);
    case "pack_approved":
    case "pack_rejected":
    case "pack_deactivated":
      return merchantPackHref(e.pack_id);
  }
}

/**
 * Which pack notification a staff status change sends, or null when nothing
 * the merchant would notice changed. Rejecting / deactivating with a new note
 * counts as a change.
 */
export function packDecisionKind(
  before: { status: string; review_note: string | null },
  after: { status: "active" | "inactive"; note?: string | null }
): "pack_approved" | "pack_rejected" | "pack_deactivated" | null {
  if (after.status === "active") return before.status === "active" ? null : "pack_approved";
  const note = after.note?.trim() || null;
  if (before.status === "inactive" && (note ?? null) === (before.review_note ?? null)) return null;
  return before.status === "active" ? "pack_deactivated" : "pack_rejected";
}
