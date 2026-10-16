// Trilingual notification copy for staff Blink Cash actions (same shape and
// style as agent-dues-reminder.ts / routes/transactions/process.ts).
type Copy = { title: string; description: string };
export type BlinkCashCopy = { en: Copy; fr: Copy; ar: Copy };

const da = (n: number) => `${Math.round(Math.abs(n)).toLocaleString("fr-DZ")} DA`;

export type TxnEvent = "approved" | "rejected" | "cancelled" | "reversed";

export function txnEventCopy(event: TxnEvent, type: "deposit" | "withdrawal", amount: number): BlinkCashCopy {
  const dep = type === "deposit";
  const a = da(amount);
  switch (event) {
    case "approved":
      return {
        en: { title: dep ? "Deposit confirmed" : "Withdrawal confirmed", description: `Your ${dep ? "deposit" : "withdrawal"} of ${a} was approved.` },
        fr: { title: dep ? "Dépôt confirmé" : "Retrait confirmé", description: `Votre ${dep ? "dépôt" : "retrait"} de ${a} a été approuvé.` },
        ar: { title: dep ? "تم تأكيد الإيداع" : "تم تأكيد السحب", description: `تمت الموافقة على ${dep ? "إيداعك" : "سحبك"} بقيمة ${a}.` },
      };
    case "rejected":
      return {
        en: { title: dep ? "Deposit rejected" : "Withdrawal rejected", description: `Your ${dep ? "deposit" : "withdrawal"} of ${a} was rejected. Nothing was charged.` },
        fr: { title: dep ? "Dépôt refusé" : "Retrait refusé", description: `Votre ${dep ? "dépôt" : "retrait"} de ${a} a été refusé. Aucun montant n'a été débité.` },
        ar: { title: dep ? "تم رفض الإيداع" : "تم رفض السحب", description: `تم رفض ${dep ? "إيداعك" : "سحبك"} بقيمة ${a}. لم يتم خصم أي مبلغ.` },
      };
    case "cancelled":
      return {
        en: { title: dep ? "Deposit cancelled" : "Withdrawal cancelled", description: `Your ${dep ? "deposit" : "withdrawal"} of ${a} was cancelled by Blink.` },
        fr: { title: dep ? "Dépôt annulé" : "Retrait annulé", description: `Votre ${dep ? "dépôt" : "retrait"} de ${a} a été annulé par Blink.` },
        ar: { title: dep ? "تم إلغاء الإيداع" : "تم إلغاء السحب", description: `ألغت Blink ${dep ? "إيداعك" : "سحبك"} بقيمة ${a}.` },
      };
    case "reversed":
      return {
        en: { title: dep ? "Deposit reversed" : "Withdrawal reversed", description: `Your ${dep ? "deposit" : "withdrawal"} of ${a} was reversed and your balance was updated.` },
        fr: { title: dep ? "Dépôt annulé (inversé)" : "Retrait annulé (inversé)", description: `Votre ${dep ? "dépôt" : "retrait"} de ${a} a été inversé et votre solde mis à jour.` },
        ar: { title: dep ? "تم عكس الإيداع" : "تم عكس السحب", description: `تم عكس ${dep ? "إيداعك" : "سحبك"} بقيمة ${a} وتحديث رصيدك.` },
      };
  }
}

export function adjustmentCopy(amount: number): BlinkCashCopy {
  const credit = amount > 0;
  const a = da(amount);
  return {
    en: { title: "Balance adjusted", description: `${a} was ${credit ? "added to" : "taken from"} your Blink Cash balance.` },
    fr: { title: "Solde ajusté", description: `${a} ${credit ? "ont été ajoutés à" : "ont été retirés de"} votre solde Blink Cash.` },
    ar: { title: "تم تعديل الرصيد", description: `${credit ? "تمت إضافة" : "تم خصم"} ${a} ${credit ? "إلى" : "من"} رصيد Blink Cash الخاص بك.` },
  };
}

export function freezeCopy(frozen: boolean): BlinkCashCopy {
  return frozen
    ? {
        en: { title: "Blink Cash frozen", description: "Withdrawals from your Blink Cash wallet are paused. Contact support." },
        fr: { title: "Blink Cash gelé", description: "Les retraits de votre portefeuille Blink Cash sont suspendus. Contactez le support." },
        ar: { title: "تم تجميد Blink Cash", description: "تم إيقاف السحب من محفظة Blink Cash الخاصة بك. تواصل مع الدعم." },
      }
    : {
        en: { title: "Blink Cash unfrozen", description: "Your Blink Cash wallet is active again." },
        fr: { title: "Blink Cash dégelé", description: "Votre portefeuille Blink Cash est de nouveau actif." },
        ar: { title: "تم إلغاء تجميد Blink Cash", description: "محفظة Blink Cash الخاصة بك نشطة مرة أخرى." },
      };
}

export type DuesEvent = "recorded" | "confirmed" | "rejected";

export function duesPaymentCopy(event: DuesEvent, amount: number): BlinkCashCopy {
  const a = da(amount);
  switch (event) {
    case "recorded":
    case "confirmed":
      return {
        en: { title: "Payment received", description: `Blink received your dues payment of ${a}.` },
        fr: { title: "Paiement reçu", description: `Blink a reçu votre paiement de ${a}.` },
        ar: { title: "تم استلام الدفعة", description: `استلمت Blink دفعة مستحقاتك بقيمة ${a}.` },
      };
    case "rejected":
      return {
        en: { title: "Payment rejected", description: `Your dues payment of ${a} could not be verified. It was not counted.` },
        fr: { title: "Paiement refusé", description: `Votre paiement de ${a} n'a pas pu être vérifié. Il n'a pas été comptabilisé.` },
        ar: { title: "تم رفض الدفعة", description: `تعذّر التحقق من دفعة مستحقاتك بقيمة ${a}. لم يتم احتسابها.` },
      };
  }
}
