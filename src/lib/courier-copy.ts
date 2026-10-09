// Customer notifications for courier (parcel) requests, in en / fr / ar.
// Courier events are sent as type "courier" and open the tracking screen
// (`courierHref`), instead of the generic "order" copy, which says "order" and
// "on its way to you" (a parcel usually goes to someone else).

type Copy = { title: string; description: string };
export type CourierCopy = { en: Copy; fr: Copy; ar: Copy };

/** The customer app's tracking screen for this courier order. */
export const courierHref = (orderId: string) => `/(customer)/activities/courier/${orderId}`;

export type CourierEvent =
  | { kind: "accepted"; scheduled: boolean }
  | { kind: "started" }
  | { kind: "arrived" }
  | { kind: "picked_up"; to: string }
  | { kind: "dropped_off"; to: string; done: number; total: number }
  | { kind: "delivered"; to: string }
  | { kind: "rider_canceled" }
  | { kind: "no_rider" };

export function courierCopy(ref: string, e: CourierEvent): CourierCopy {
  switch (e.kind) {
    case "accepted":
      return e.scheduled
        ? {
            en: { title: "Courier booked", description: `A rider booked your parcel delivery ${ref} for the scheduled time.` },
            fr: { title: "Coursier réservé", description: `Un livreur a réservé votre livraison de colis ${ref} pour l'heure prévue.` },
            ar: { title: "تم حجز الساعي", description: `حجز سائق توصيل طردك ${ref} في الموعد المحدد.` },
          }
        : {
            en: { title: "Rider found", description: `A rider accepted your parcel delivery ${ref} and is heading to the pickup.` },
            fr: { title: "Livreur trouvé", description: `Un livreur a accepté votre livraison de colis ${ref} et se rend au point de retrait.` },
            ar: { title: "تم العثور على سائق", description: `قبل سائق توصيل طردك ${ref} وهو في الطريق إلى نقطة الاستلام.` },
          };
    case "started":
      return {
        en: { title: "Rider on the way", description: `Your rider is heading to the pickup for ${ref}.` },
        fr: { title: "Livreur en route", description: `Votre livreur se rend au point de retrait pour ${ref}.` },
        ar: { title: "السائق في الطريق", description: `سائقك في الطريق إلى نقطة الاستلام للطلب ${ref}.` },
      };
    case "arrived":
      return {
        en: { title: "Rider at pickup", description: `Your rider is at the pickup point for ${ref}. Have the parcel ready.` },
        fr: { title: "Livreur au point de retrait", description: `Votre livreur est au point de retrait pour ${ref}. Préparez le colis.` },
        ar: { title: "السائق في نقطة الاستلام", description: `سائقك في نقطة الاستلام للطلب ${ref}. جهّز الطرد.` },
      };
    case "picked_up":
      return {
        en: { title: "Parcel picked up", description: `Your parcel ${ref} is on its way to ${e.to}.` },
        fr: { title: "Colis récupéré", description: `Votre colis ${ref} est en route vers ${e.to}.` },
        ar: { title: "تم استلام الطرد", description: `طردك ${ref} في الطريق إلى ${e.to}.` },
      };
    case "dropped_off":
      return {
        en: { title: `Delivered to ${e.to}`, description: `Stop ${e.done} of ${e.total} done for ${ref}. Heading to the next one.` },
        fr: { title: `Livré à ${e.to}`, description: `Arrêt ${e.done} sur ${e.total} effectué pour ${ref}. Direction le suivant.` },
        ar: { title: `تم التسليم إلى ${e.to}`, description: `اكتملت المحطة ${e.done} من ${e.total} للطلب ${ref}. التوجه إلى المحطة التالية.` },
      };
    case "delivered":
      return {
        en: { title: "Parcel delivered", description: `${ref} was delivered to ${e.to}. Tap to rate your rider.` },
        fr: { title: "Colis livré", description: `${ref} a été livré à ${e.to}. Touchez pour noter votre livreur.` },
        ar: { title: "تم توصيل الطرد", description: `تم توصيل ${ref} إلى ${e.to}. اضغط لتقييم سائقك.` },
      };
    case "rider_canceled":
      return {
        en: { title: "Finding a new rider", description: `Your rider dropped parcel delivery ${ref}. We're finding another one.` },
        fr: { title: "Recherche d'un nouveau livreur", description: `Votre livreur a abandonné la livraison ${ref}. Nous en cherchons un autre.` },
        ar: { title: "البحث عن سائق جديد", description: `تخلّى السائق عن توصيل الطرد ${ref}. نبحث عن سائق آخر.` },
      };
    case "no_rider":
      return {
        en: { title: "No rider available", description: `Nobody could take parcel delivery ${ref}, so it was canceled. Please try again.` },
        fr: { title: "Aucun livreur disponible", description: `Aucun livreur n'a pu prendre la livraison ${ref}, elle a été annulée. Veuillez réessayer.` },
        ar: { title: "لا يوجد سائق متاح", description: `لم يتمكن أي سائق من أخذ توصيل الطرد ${ref}، فتم إلغاؤه. يرجى المحاولة مجددًا.` },
      };
  }
}
