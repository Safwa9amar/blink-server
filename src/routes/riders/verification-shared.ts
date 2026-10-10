// DB glue for rider verification: load the row, sign preview URLs, check
// access. The rules themselves are pure (src/lib/rider-verification.ts,
// src/lib/rider-access.ts).
import { riderCanWork } from "../../lib/rider-access";
import {
  RIDER_DOCUMENT_KEYS,
  type RiderDocumentKey,
  type RiderStoredDocuments,
  type RiderVerificationState,
  type RiderVerificationStatus,
} from "../../lib/rider-verification";
import { supabaseAdmin } from "../../lib/supabase";

/** Private bucket (20261010210000 migration). */
export const RIDER_DOCS_BUCKET = "rider-documents";
const SIGNED_URL_TTL_S = 60 * 60;

export type RiderVerificationRow = RiderVerificationState & { vehicle_type: string | null };

/** A transient DB/storage failure (not a client mistake): routes answer 503. */
export class RiderDataUnavailableError extends Error {}

/**
 * The rider's verification state; null when the user has no rider profile.
 * Throws RiderDataUnavailableError on a DB error (do not report it as 404).
 */
export async function loadRiderVerification(userId: string): Promise<RiderVerificationRow | null> {
  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .select("documents, verification_status, vehicle_type")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new RiderDataUnavailableError(error.message);
  if (!data) return null;
  return {
    documents: (data.documents ?? {}) as RiderStoredDocuments,
    verification_status: (data.verification_status ?? "not_submitted") as RiderVerificationStatus,
    vehicle_type: (data.vehicle_type as string | null) ?? null,
  };
}

type DocumentView = {
  status: "pending" | "verified" | "rejected";
  note: string | null;
  uploaded_at: string;
  preview_url: string | null;
  content_type: "image" | "pdf";
};

// Legacy rows copied from license_*_url hold a full URL instead of a path.
const isUrl = (p: string) => /^https?:\/\//i.test(p);

/** Stored documents → RiderDocumentsResponse, with 1-hour signed preview URLs. */
export async function documentsView(state: RiderVerificationState) {
  const toSign = RIDER_DOCUMENT_KEYS.map((k) => state.documents[k]?.path).filter(
    (p): p is string => !!p && !isUrl(p)
  );
  const signed = new Map<string, string>();
  if (toSign.length) {
    const { data } = await supabaseAdmin.storage.from(RIDER_DOCS_BUCKET).createSignedUrls(toSign, SIGNED_URL_TTL_S);
    for (const s of data ?? []) if (s.path && s.signedUrl) signed.set(s.path, s.signedUrl);
  }
  const documents = Object.fromEntries(
    RIDER_DOCUMENT_KEYS.map((k) => {
      const d = state.documents[k];
      if (!d) return [k, null];
      const view: DocumentView = {
        status: d.status,
        note: d.note ?? null,
        uploaded_at: d.uploaded_at,
        preview_url: isUrl(d.path) ? d.path : signed.get(d.path) ?? null,
        content_type: d.path.toLowerCase().endsWith(".pdf") ? "pdf" : "image",
      };
      return [k, view];
    })
  ) as Record<RiderDocumentKey, DocumentView | null>;
  return { verification_status: state.verification_status, documents };
}

/** True when the object exists; throws RiderDataUnavailableError on a storage error. */
export async function documentObjectExists(path: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.storage.from(RIDER_DOCS_BUCKET).exists(path);
    if (error) throw error;
    return data;
  } catch (e) {
    throw new RiderDataUnavailableError(e instanceof Error ? e.message : "storage error");
  }
}

/**
 * Compare-and-swap write of documents + status: only applies if `documents`
 * still equals what the caller loaded (jsonb equality, key order irrelevant;
 * `documents` is NOT NULL DEFAULT '{}'). updated_at is deliberately not used —
 * a trigger bumps it on location updates. Reused by the staff review route.
 */
export async function writeRiderDocumentsCAS(
  userId: string,
  expectedDocs: RiderStoredDocuments,
  nextDocs: RiderStoredDocuments,
  nextStatus: RiderVerificationStatus
): Promise<"ok" | "conflict" | "error"> {
  const { data, error } = await supabaseAdmin
    .from("rider_profiles")
    .update({ documents: nextDocs, verification_status: nextStatus })
    .eq("user_id", userId)
    .eq("documents", JSON.stringify(expectedDocs))
    .select("user_id");
  if (error) return "error";
  return data && data.length > 0 ? "ok" : "conflict";
}

/** riderCanWork for a user id (false when there is no rider profile). */
export async function riderAccess(userId: string) {
  const { data } = await supabaseAdmin
    .from("rider_profiles")
    .select("verification_status")
    .eq("user_id", userId)
    .maybeSingle();
  return riderCanWork(data);
}
