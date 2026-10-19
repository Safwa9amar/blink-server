// Partner notifications for pricing deals (overrides targeted at one merchant
// or one agent), in en / fr / ar. Sent as type "alert" with `payload.kind` =
// "pricing_deal_*" (see routes/pricing/admin.ts).

type Copy = { title: string; description: string };
export type PricingDealCopy = { en: Copy; fr: Copy; ar: Copy };

/** Keys a partner-targeted override can be about, and who it is for. */
export const PARTNER_DEAL_KEYS = {
  merchant_commission_rate: "merchant",
  agent_platform_share: "agent",
} as const;
export type PartnerDealKey = keyof typeof PARTNER_DEAL_KEYS;

export const isPartnerDealKey = (k: string): k is PartnerDealKey => k in PARTNER_DEAL_KEYS;

export type PricingDealEvent = {
  kind: "created" | "updated" | "archived";
  key: PartnerDealKey;
  /** The deal's rate (0.03 = 3%). */
  rate: number;
  /** The rate the partner falls back to (the default, or a looser deal). */
  defaultRate: number;
  startsAt?: string | null;
  endsAt?: string | null;
};

/** 0.03 → "3%", 0.025 → "2.5%". */
export const pct = (rate: number) => `${Math.round(rate * 10_000) / 100}%`;

const MONTHS = {
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."],
  ar: ["جانفي", "فيفري", "مارس", "أفريل", "ماي", "جوان", "جويلية", "أوت", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
} as const;

/** "1 Nov 2026" in Algeria time (UTC+1, no DST). */
export function dealDate(iso: string, lang: keyof typeof MONTHS): string {
  const d = new Date(Date.parse(iso) + 3_600_000);
  return `${d.getUTCDate()} ${MONTHS[lang][d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const LABEL = {
  merchant_commission_rate: { en: "Blink commission", fr: "commission Blink", ar: "عمولة بلينك" },
  agent_platform_share: {
    en: "Blink's share of Blink Cash fees",
    fr: "part de Blink sur les frais Blink Cash",
    ar: "حصة بلينك من رسوم بلينك كاش",
  },
} as const;

const TITLE = {
  created: { en: "New Blink deal", fr: "Nouvelle offre Blink", ar: "عرض جديد من بلينك" },
  updated: { en: "Your Blink deal was updated", fr: "Votre offre Blink a été modifiée", ar: "تم تعديل عرضك من بلينك" },
  archived: { en: "Your Blink deal has ended", fr: "Votre offre Blink est terminée", ar: "انتهى عرضك من بلينك" },
} as const;

function window(e: PricingDealEvent, lang: keyof typeof MONTHS): string {
  const from = e.startsAt ? dealDate(e.startsAt, lang) : null;
  const to = e.endsAt ? dealDate(e.endsAt, lang) : null;
  const w = {
    en: [from && `from ${from}`, to && `until ${to}`],
    fr: [from && `à partir du ${from}`, to && `jusqu'au ${to}`],
    ar: [from && `من ${from}`, to && `حتى ${to}`],
  }[lang]
    .filter(Boolean)
    .join(" ");
  return w ? ` ${w}` : "";
}

export function pricingDealCopy(e: PricingDealEvent): PricingDealCopy {
  const langs = ["en", "fr", "ar"] as const;
  const out = {} as PricingDealCopy;
  for (const lang of langs) {
    const label = LABEL[e.key][lang];
    const title = TITLE[e.kind][lang];
    let description: string;
    if (e.kind === "archived") {
      description = {
        en: `Your ${label} returns to ${pct(e.defaultRate)}.`,
        fr: `Votre ${label} revient à ${pct(e.defaultRate)}.`,
        ar: `ترجع ${label} الخاصة بك إلى ${pct(e.defaultRate)}.`,
      }[lang];
    } else {
      const w = window(e, lang);
      description = {
        en: `Your ${label} is ${pct(e.rate)}${w || " until further notice"}.`,
        fr: `Votre ${label} est de ${pct(e.rate)}${w || " jusqu'à nouvel ordre"}.`,
        ar: `${label} الخاصة بك هي ${pct(e.rate)}${w || " حتى إشعار آخر"}.`,
      }[lang];
    }
    out[lang] = { title, description };
  }
  return out;
}
