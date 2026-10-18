// Algerian wilaya lookups. Codes are the `algeria-locations` ones ("1"…"58",
// no zero padding) — the codes the mobile app's WilayaBottomSheet uses.
//
//  - wilayaAt(lat, lng): point-in-polygon over simplified boundaries
//    (wilaya-data.ts; source + licence in its header).
//  - normalizeWilaya(text): free text (code, en/fr/ar name) → code.
import { WILAYA_POLYGONS } from "./wilaya-data";

/** [name (fr/latin), name (ar)] for codes "1"…"58", in code order. */
const NAMES: [string, string][] = [
  ["Adrar", "أدرار"],
  ["Chlef", "الشلف"],
  ["Laghouat", "الأغواط"],
  ["Oum El Bouaghi", "أم البواقي"],
  ["Batna", "باتنة"],
  ["Béjaïa", "بجاية"],
  ["Biskra", "بسكرة"],
  ["Béchar", "بشار"],
  ["Blida", "البليدة"],
  ["Bouira", "البويرة"],
  ["Tamanrasset", "تمنراست"],
  ["Tébessa", "تبسة"],
  ["Tlemcen", "تلمسان"],
  ["Tiaret", "تيارت"],
  ["Tizi Ouzou", "تيزي وزو"],
  ["Alger", "الجزائر"],
  ["Djelfa", "الجلفة"],
  ["Jijel", "جيجل"],
  ["Sétif", "سطيف"],
  ["Saïda", "سعيدة"],
  ["Skikda", "سكيكدة"],
  ["Sidi Bel Abbès", "سيدي بلعباس"],
  ["Annaba", "عنابة"],
  ["Guelma", "قالمة"],
  ["Constantine", "قسنطينة"],
  ["Médéa", "المدية"],
  ["Mostaganem", "مستغانم"],
  ["M'Sila", "المسيلة"],
  ["Mascara", "معسكر"],
  ["Ouargla", "ورقلة"],
  ["Oran", "وهران"],
  ["El Bayadh", "البيض"],
  ["Illizi", "إليزي"],
  ["Bordj Bou Arréridj", "برج بوعريريج"],
  ["Boumerdès", "بومرداس"],
  ["El Tarf", "الطارف"],
  ["Tindouf", "تندوف"],
  ["Tissemsilt", "تيسمسيلت"],
  ["El Oued", "الوادي"],
  ["Khenchela", "خنشلة"],
  ["Souk Ahras", "سوق أهراس"],
  ["Tipaza", "تيبازة"],
  ["Mila", "ميلة"],
  ["Aïn Defla", "عين الدفلى"],
  ["Naâma", "النعامة"],
  ["Aïn Témouchent", "عين تموشنت"],
  ["Ghardaïa", "غرداية"],
  ["Relizane", "غليزان"],
  ["Timimoun", "تيميمون"],
  ["Bordj Badji Mokhtar", "برج باجي مختار"],
  ["Ouled Djellal", "أولاد جلال"],
  ["Béni Abbès", "بني عباس"],
  ["In Salah", "عين صالح"],
  ["In Guezzam", "عين قزام"],
  ["Touggourt", "تقرت"],
  ["Djanet", "جانت"],
  ["El M'Ghair", "المغير"],
  ["El Meniaa", "المنيعة"],
];

/** English / alternative spellings the fr names don't cover. */
const ALIASES: Record<string, string> = {
  algiers: "16",
  eldjazair: "16",
  aljazair: "16",
  setif: "19",
  constantine: "25",
  tlemcen: "13",
  mostaganem: "27",
  medea: "26",
  tamenghasset: "11",
  tamanghasset: "11",
  tebessa: "12",
  tizi: "15",
  bordjbouarreridj: "34",
  bba: "34",
  sba: "22",
  oumelbouaghi: "4",
  ouledjelal: "51",
  elmghair: "57",
  elmeghair: "57",
  elmenia: "58",
  elmeniaa: "58",
  elmenea: "58",
  ghardaia: "47",
  beniabbes: "52",
  bordjbadjimokhtar: "50",
  djanet: "56",
};

/** Lowercase, strip Latin accents + Arabic diacritics, unify Arabic letter variants, keep letters only. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ًͯ-ٰٟـ]/g, "")
    .toLowerCase()
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^a-zء-ي]/g, "");
}

const BY_NAME = new Map<string, string>();
NAMES.forEach(([fr, ar], i) => {
  const code = String(i + 1);
  BY_NAME.set(fold(fr), code);
  BY_NAME.set(fold(ar), code);
});
for (const [k, v] of Object.entries(ALIASES)) BY_NAME.set(fold(k), v);

/**
 * Wilaya code ("1"…"58") for free text: a code ("16", "016", "DZ-16"), or an
 * en/fr/ar name, any case/accents, optionally prefixed ("Wilaya de Blida",
 * "ولاية البليدة"). Null when nothing matches.
 */
export function normalizeWilaya(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const digits = raw.match(/^(?:dz[-\s]?)?0*(\d{1,2})$/i);
  if (digits) {
    const n = Number(digits[1]);
    return n >= 1 && n <= 58 ? String(n) : null;
  }
  // "16 - Alger", "16-Alger": a leading code wins.
  const lead = raw.match(/^0*(\d{1,2})\s*[-–:.]\s*\S/);
  if (lead && Number(lead[1]) >= 1 && Number(lead[1]) <= 58) return String(Number(lead[1]));
  let key = fold(raw);
  const direct = BY_NAME.get(key);
  if (direct) return direct;
  for (const prefix of ["wilayade", "wilayad", "wilaya", "willaya", "ولايه", "ولايةال"].map(fold)) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  }
  const stripped = BY_NAME.get(key) ?? BY_NAME.get(key.replace(/^dal/, "")) ?? null;
  return stripped;
}

// ─── Point in polygon ────────────────────────────────────────────────

type Ring = { pts: Float64Array; minX: number; maxX: number; minY: number; maxY: number };
let RINGS: [string, Ring[]][] | null = null;

function decode(): [string, Ring[]][] {
  return Object.entries(WILAYA_POLYGONS).map(([code, polys]) => [
    code,
    polys.map((flat) => {
      const pts = new Float64Array(flat.length);
      let x = 0;
      let y = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i < flat.length; i += 2) {
        x += flat[i];
        y += flat[i + 1];
        const lng = x / 1000;
        const lat = y / 1000;
        pts[i] = lng;
        pts[i + 1] = lat;
        if (lng < minX) minX = lng;
        if (lng > maxX) maxX = lng;
        if (lat < minY) minY = lat;
        if (lat > maxY) maxY = lat;
      }
      return { pts, minX, maxX, minY, maxY };
    }),
  ]);
}

function inRing(r: Ring, lng: number, lat: number): boolean {
  if (lng < r.minX || lng > r.maxX || lat < r.minY || lat > r.maxY) return false;
  const p = r.pts;
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Wilaya code containing the point, or null (outside Algeria / at sea). */
export function wilayaAt(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  RINGS ??= decode();
  for (const [code, rings] of RINGS) {
    for (const r of rings) if (inRing(r, lng, lat)) return code;
  }
  return null;
}
