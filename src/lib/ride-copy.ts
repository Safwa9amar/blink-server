// Customer notifications for rides (passenger moto-taxi), in en / fr / ar.
// Ride events are sent as type "ride" and open the tracking screen
// (`rideHref`), instead of the generic "order" copy, which talks about an
// order being delivered — a ride carries a passenger.

type Copy = { title: string; description: string };
export type RideCopy = { en: Copy; fr: Copy; ar: Copy };

/** The customer app's tracking screen for this ride. */
export const rideHref = (orderId: string) => `/(customer)/activities/ride/${orderId}`;

export type RideEvent =
  | { kind: "accepted"; scheduled: boolean }
  | { kind: "started" }
  | { kind: "arrived" }
  | { kind: "picked_up"; to: string }
  | { kind: "delivered" }
  | { kind: "rider_canceled" }
  | { kind: "no_rider" }
  | { kind: "canceled_by_rider" };

export function rideCopy(ref: string, e: RideEvent): RideCopy {
  switch (e.kind) {
    case "accepted":
      return e.scheduled
        ? {
            en: { title: "Ride booked", description: `A rider booked your ride ${ref} for the scheduled time.` },
            fr: { title: "Course réservée", description: `Un chauffeur a réservé votre course ${ref} pour l'heure prévue.` },
            ar: { title: "تم حجز الرحلة", description: `حجز سائق رحلتك ${ref} في الموعد المحدد.` },
          }
        : {
            en: { title: "Rider found", description: `A rider accepted your ride ${ref} and is on the way to the pickup.` },
            fr: { title: "Chauffeur trouvé", description: `Un chauffeur a accepté votre course ${ref} et arrive au point de départ.` },
            ar: { title: "تم العثور على سائق", description: `قبل سائق رحلتك ${ref} وهو في الطريق إلى نقطة الانطلاق.` },
          };
    case "started":
      return {
        en: { title: "Rider on the way", description: `Your rider is heading to the pickup for ride ${ref}.` },
        fr: { title: "Chauffeur en route", description: `Votre chauffeur se rend au point de départ pour la course ${ref}.` },
        ar: { title: "السائق في الطريق", description: `سائقك في الطريق إلى نقطة الانطلاق للرحلة ${ref}.` },
      };
    case "arrived":
      return {
        en: { title: "Your rider has arrived", description: `Your rider is waiting at the pickup for ride ${ref}.` },
        fr: { title: "Votre chauffeur est arrivé", description: `Votre chauffeur attend au point de départ pour la course ${ref}.` },
        ar: { title: "وصل سائقك", description: `سائقك ينتظر في نقطة الانطلاق للرحلة ${ref}.` },
      };
    case "picked_up":
      return {
        en: { title: "Ride started", description: `Ride ${ref} is on its way to ${e.to}.` },
        fr: { title: "Course démarrée", description: `La course ${ref} est en route vers ${e.to}.` },
        ar: { title: "بدأت الرحلة", description: `الرحلة ${ref} في الطريق إلى ${e.to}.` },
      };
    case "delivered":
      return {
        en: { title: "You've arrived", description: `Ride ${ref} is complete. Tap to rate your ride.` },
        fr: { title: "Vous êtes arrivé", description: `La course ${ref} est terminée. Touchez pour noter votre course.` },
        ar: { title: "لقد وصلت", description: `انتهت الرحلة ${ref}. اضغط لتقييم رحلتك.` },
      };
    case "rider_canceled":
      return {
        en: { title: "Finding a new rider", description: `Your rider canceled ride ${ref}. We're finding another one.` },
        fr: { title: "Recherche d'un nouveau chauffeur", description: `Votre chauffeur a annulé la course ${ref}. Nous en cherchons un autre.` },
        ar: { title: "البحث عن سائق جديد", description: `ألغى السائق الرحلة ${ref}. نبحث عن سائق آخر.` },
      };
    case "no_rider":
      return {
        en: { title: "No rider available", description: `Nobody could take ride ${ref}, so it was canceled. Please try again.` },
        fr: { title: "Aucun chauffeur disponible", description: `Aucun chauffeur n'a pu prendre la course ${ref}, elle a été annulée. Veuillez réessayer.` },
        ar: { title: "لا يوجد سائق متاح", description: `لم يتمكن أي سائق من أخذ الرحلة ${ref}، فتم إلغاؤها. يرجى المحاولة مجددًا.` },
      };
    case "canceled_by_rider":
      return {
        en: { title: "Ride canceled", description: `Your rider waited at the pickup but the passenger didn't show up, so ride ${ref} was canceled.` },
        fr: { title: "Course annulée", description: `Votre chauffeur a attendu au point de départ mais le passager ne s'est pas présenté : la course ${ref} a été annulée.` },
        ar: { title: "تم إلغاء الرحلة", description: `انتظر السائق في نقطة الانطلاق لكن الراكب لم يحضر، فتم إلغاء الرحلة ${ref}.` },
      };
  }
}
