// Merchant notification copy for staff's per-document verdicts
// (PATCH /merchant/admin/stores/{id}/documents), in en / fr / ar. Sent as type
// "alert" with `payload.kind` = store_document_rejected (one document refused,
// with the reason) or store_documents_verified (every required document is now
// verified). Opens the store's page (storeReviewHref in store-review-copy.ts).
import { isScanDocument, type StoreDocKey, type StoreDocumentNotification } from "./store-documents";

type Copy = { title: string; description: string };
type Lang = "en" | "fr" | "ar";
export type StoreDocumentCopy = { kind: StoreDocumentNotification; en: Copy; fr: Copy; ar: Copy };

const DOC_NAMES: Record<StoreDocKey, Record<Lang, string>> = {
  commercial_register_front: {
    en: "Commercial register (front)",
    fr: "Registre du commerce (recto)",
    ar: "السجل التجاري (الوجه الأمامي)",
  },
  commercial_register_back: {
    en: "Commercial register (back)",
    fr: "Registre du commerce (verso)",
    ar: "السجل التجاري (الوجه الخلفي)",
  },
  nif: { en: "NIF", fr: "NIF", ar: "رقم التعريف الجبائي (NIF)" },
  nis: { en: "NIS", fr: "NIS", ar: "رقم التعريف الإحصائي (NIS)" },
};

/** The document's name in the merchant's language. */
export const storeDocumentName = (key: StoreDocKey, lang: Lang) => DOC_NAMES[key][lang];

/**
 * What to tell the store's owner after a document verdict (see
 * resolveStoreDocumentReview's `notify`): a rejection names the document and
 * carries staff's reason; "verified" means all required documents are.
 */
export function storeDocumentCopy(input: {
  kind: StoreDocumentNotification;
  name: string;
  document: StoreDocKey;
  reason?: string | null;
}): StoreDocumentCopy {
  const { kind, name, document } = input;

  if (kind === "store_documents_verified") {
    return {
      kind,
      en: { title: "Documents verified", description: `Blink verified all the documents of ${name}.` },
      fr: { title: "Documents vérifiés", description: `Blink a vérifié tous les documents de ${name}.` },
      ar: { title: "تم التحقق من الوثائق", description: `تحققت Blink من جميع وثائق ${name}.` },
    };
  }

  const reason = input.reason?.trim();
  const scan = isScanDocument(document);
  const doc = (lang: Lang) => storeDocumentName(document, lang);
  // Store names often carry a dash ("Blink Mart — Hydra"): the reason follows a colon.
  const why = (sep: string) => (reason ? `${sep}${reason}` : "");
  return {
    kind,
    en: {
      title: "Document rejected",
      description: `${doc("en")} of ${name} was rejected${why(": ")}. ${scan ? "Please upload a new one." : "Please check and correct it."}`,
    },
    fr: {
      title: "Document refusé",
      description: `${doc("fr")} de ${name} a été refusé${why(" : ")}. ${scan ? "Veuillez en téléverser un nouveau." : "Veuillez le vérifier et le corriger."}`,
    },
    ar: {
      title: "تم رفض وثيقة",
      description: `تم رفض ${doc("ar")} الخاص بـ ${name}${why(": ")}. ${scan ? "يرجى رفع نسخة جديدة." : "يرجى التحقق منه وتصحيحه."}`,
    },
  };
}
