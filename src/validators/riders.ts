import { z } from "@hono/zod-openapi";
import { RIDER_DOCUMENT_KEYS } from "../lib/rider-verification";
import { RiderProfileSchema, RiderVerificationStatusSchema, VehicleSchema } from "./auth";

// Only rider-specific fields. Common fields (wilaya, bank_rib) are on users and
// saved via PATCH /auth/profile.
export const updateRiderProfileSchema = z
  .object({
    vehicle_type: z.enum(["bicycle", "motorcycle"]).optional(),
  })
  .openapi("UpdateRiderProfileBody");

export const upsertVehicleSchema = z
  .object({
    brand: z.string().min(1),
    model: z.string().min(1),
    license_plate: z.string().min(1),
    year: z.string().min(1),
    color: z.string().min(1),
    category: z.enum(["standard", "electric", "hybrid"]),
  })
  .openapi("UpsertVehicleBody");

export const RiderProfileResponse = z
  .object({ profile: RiderProfileSchema })
  .openapi("RiderProfileResponse");

export const VehicleResponse = z
  .object({ vehicle: VehicleSchema })
  .openapi("VehicleResponse");

/** GET /riders/vehicle — `vehicle` is null when the rider has none yet. */
export const OptionalVehicleResponse = z
  .object({ vehicle: VehicleSchema.nullable() })
  .openapi("OptionalVehicleResponse");

// ─── Verification (licence + national ID) ────────────────────────────

export const RiderDocumentKeySchema = z
  .enum(RIDER_DOCUMENT_KEYS)
  .openapi("RiderDocumentKey");

export const riderUploadSchema = z
  .object({
    // 8 MiB of bytes = 11_184_812 base64 chars — the bucket's file size limit.
    base64: z.string().min(1).max(11_184_812),
    content_type: z.enum(["image/jpeg", "image/png", "image/webp", "application/pdf"]),
    document: RiderDocumentKeySchema,
  })
  .openapi("RiderUploadBody");

/** Object path in the private rider-documents bucket — pass it to PATCH /riders/documents. */
export const RiderUploadResponse = z.object({ path: z.string() }).openapi("RiderUploadResponse");

/** Paths returned by POST /riders/uploads; a new path resets that document to pending. */
export const updateRiderDocumentsSchema = z
  .object({
    license_front: z.string().min(1).max(300).optional(),
    license_back: z.string().min(1).max(300).optional(),
    id_front: z.string().min(1).max(300).optional(),
    id_back: z.string().min(1).max(300).optional(),
  })
  .openapi("UpdateRiderDocumentsBody");

export const RiderDocumentViewSchema = z
  .object({
    status: z.enum(["pending", "verified", "rejected"]),
    note: z.string().nullable(),
    uploaded_at: z.string(),
    /** Signed URL (1 h) for the preview; null if signing failed. */
    preview_url: z.string().nullable(),
    content_type: z.enum(["image", "pdf"]),
  })
  .openapi("RiderDocumentView");

export const RiderDocumentsResponse = z
  .object({
    verification_status: RiderVerificationStatusSchema,
    documents: z.object({
      license_front: RiderDocumentViewSchema.nullable(),
      license_back: RiderDocumentViewSchema.nullable(),
      id_front: RiderDocumentViewSchema.nullable(),
      id_back: RiderDocumentViewSchema.nullable(),
    }),
  })
  .openapi("RiderDocumentsResponse");

export const reviewRiderDocumentSchema = z
  .object({
    document: RiderDocumentKeySchema,
    /** The stored object path being reviewed — rejected (409 stale_review) if
     *  the rider has since replaced the document. */
    path: z.string().min(1).max(300),
    status: z.enum(["verified", "rejected"]),
    /** Shown to the rider on a rejection. */
    note: z.string().max(300).optional(),
  })
  .openapi("ReviewRiderDocumentBody");

export const RiderRequiredActionSchema = z
  .object({
    key: z.enum(["vehicle_type", "driving_license", "national_id", "verification"]),
    status: z.enum(["done", "missing_info", "in_progress", "rejected"]),
    /** ["vehicle_type"], ["front", "back"], or document keys. */
    missing: z.array(z.string()),
    reason: z.string().nullable(),
  })
  .openapi("RiderRequiredAction");

export const RiderRequiredActionsResponse = z
  .object({
    verification_status: RiderVerificationStatusSchema,
    actions: z.array(RiderRequiredActionSchema),
    completed: z.number().int(),
    total: z.number().int(),
  })
  .openapi("RiderRequiredActionsResponse");

/** 403 when an unverified rider tries to work (go online, accept a job). */
export const RiderNotVerifiedError = z
  .object({ error: z.string(), code: z.enum(["rider_not_verified"]).optional() })
  .openapi("RiderNotVerifiedError");

/** 409 when staff review a document the rider has since replaced. */
export const RiderStaleReviewError = z
  .object({ error: z.string(), code: z.enum(["stale_review"]) })
  .openapi("RiderStaleReviewError");
