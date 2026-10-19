// Pure helpers for the notification SMS channel (no DB, no env): the text a
// notification becomes, the phone numbers it can go to, and how many SMS it costs.

export const SMS_LANGS = ["en", "fr", "ar"] as const;
export type SmsLang = (typeof SMS_LANGS)[number];

export function isSmsLang(v: unknown): v is SmsLang {
  return typeof v === "string" && (SMS_LANGS as readonly string[]).includes(v);
}

/** Hard stop on the SMS body: ≈ 3 GSM-7 parts, ≈ 7 Unicode parts. */
export const SMS_MAX_CHARS = 480;

interface Copy {
  title?: string | null;
  description?: string | null;
}

/** A notification as stored (canonical title/description + per-language copy). */
export interface SmsSource {
  title: string;
  description: string;
  content_eng?: Copy | null;
  content_fr?: Copy | null;
  content_ar?: Copy | null;
}

/**
 * "Blink: <title>\n<message>" in one language. A language with no copy falls back
 * to the canonical (English-first) strings; one with a title but no message sends
 * the title alone rather than mixing in another language's message.
 */
export function smsText(n: SmsSource, lang: SmsLang): string {
  const copy = { en: n.content_eng, fr: n.content_fr, ar: n.content_ar }[lang];
  const ownTitle = copy?.title?.trim() ?? "";
  const ownBody = copy?.description?.trim() ?? "";
  const title = ownTitle || ownBody ? ownTitle : n.title.trim();
  const body = ownTitle || ownBody ? ownBody : n.description.trim();
  const text = [title && `Blink: ${title}`, body].filter(Boolean).join("\n") || "Blink";
  return text.length > SMS_MAX_CHARS ? `${text.slice(0, SMS_MAX_CHARS - 1).trimEnd()}…` : text;
}

/**
 * A stored phone as E.164, or null when it can't be texted. users.phone_number is
 * normally "+213…" already; local Algerian forms (0555…, 213555…, 00213…) are
 * accepted too.
 */
export function smsPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s.\-()]/g, "");
  if (/^\+\d{9,15}$/.test(s)) return s;
  if (/^00\d{9,15}$/.test(s)) return `+${s.slice(2)}`;
  if (/^213\d{9}$/.test(s)) return `+${s}`;
  if (/^0[5-7]\d{8}$/.test(s)) return `+213${s.slice(1)}`;
  return null;
}

// GSM 03.38 basic set (+ the extension table, which costs 2 characters each).
const GSM_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€\f";

/** How many SMS parts one text takes (GSM-7: 160 / 153 per part; Unicode: 70 / 67). */
export function smsSegments(text: string): number {
  let units = 0;
  let unicode = false;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      unicode = true;
      break;
    }
  }
  if (unicode) {
    const len = [...text].length;
    return len <= 70 ? 1 : Math.ceil(len / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
}
