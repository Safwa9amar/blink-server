// Staff reminder to an agent about outstanding Blink Cash dues
// (POST /agents/admin/dues/{agent_id}/remind). Cooldown helpers are shared with
// the merchant reminder (src/lib/merchant-dues.ts).
import { DUES_REMINDER_COOLDOWN_MS, remindedRecently, type DuesReminderCopy } from "./merchant-dues";

export { DUES_REMINDER_COOLDOWN_MS, remindedRecently };

/** The agent app's Blink Cash dues screen (app/(agent)/blink-cash/pay-dues.tsx). */
export const AGENT_DUES_HREF = "/(agent)/blink-cash/pay-dues";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function agentDuesReminderCopy(amount: number): DuesReminderCopy {
  const a = String(round2(amount));
  return {
    en: {
      title: "Outstanding dues",
      description: `You owe ${a} Da in Blink Cash dues. Pay them from Blink Cash.`,
    },
    fr: {
      title: "Dus en attente",
      description: `Vous devez ${a} Da de dus Blink Cash. Réglez-les depuis Blink Cash.`,
    },
    ar: {
      title: "مستحقات غير مسددة",
      description: `عليك ${a} دج من مستحقات Blink Cash. سدّدها من Blink Cash.`,
    },
  };
}
