// Staff review of merchant stores: approve, reject (in review) or deactivate
// (live), from the dashboard's /verification page. Tagged admin-* so it stays
// out of the mobile client (orval skips it). Decisions are checked against
// the store's current state and what the reviewer saw (`expected_updated_at`),
// and written with optimistic concurrency (rules: src/lib/store-review.ts).
// Approval is refused while the owner is leaving Blink (account deletion
// request pending or completed: 409 owner_leaving); rejecting / deactivating
// stays allowed.
// Each decision notifies the store owner (copy + deep link:
// src/lib/store-review-copy.ts). An approval also verifies every document the
// store has (what the reviewer saw). Staff verify / reject documents one by one
// with PATCH /merchant/admin/stores/{id}/documents (rules:
// src/lib/store-documents.ts, copy: src/lib/store-document-copy.ts).
// Product / price / pack review lives in admin-catalog-review.ts; the merchant
// resubmits in stores-resubmit.ts.
import { z } from "@hono/zod-openapi";
import { isLeavingBlink } from "../../lib/account-deletion";
import { createNotification } from "../../lib/notifications";
import { storeDocumentCopy } from "../../lib/store-document-copy";
import { documentsStatus, resolveStoreDocumentReview } from "../../lib/store-documents";
import { resolveStaffStoreReview } from "../../lib/store-review";
import { storeReviewCopy, storeReviewHref, type StoreReviewStatus } from "../../lib/store-review-copy";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  AdminReviewedStoreSchema,
  reviewStoreDocumentSchema,
  reviewStoreSchema,
  StoreDocumentReviewError,
  StoreReviewError,
} from "../../validators/merchant";

const app = router();

/** Same roles as the dashboard's /verification (ROLE_ACCESS); super_admin is implied. */
const storeStaff = requireStaffRole("ops_admin", "hr_admin");

/** The write lost a race with another edit (the row's updated_at moved on). */
const STALE = {
  error: "This store changed while you were reviewing it. Reload and try again.",
  code: "stale" as const,
};

/** The row as staff see it after a decision, with the computed document states. */
const reviewed = <T extends { documents?: unknown; document_review?: unknown }>(row: T) => ({
  ...row,
  documents_status: documentsStatus(row.documents, row.document_review),
});

const storeRoute = createRoute({
  method: "patch",
  path: "/admin/stores/{id}/status",
  operationId: "reviewMerchantStore",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [storeStaff] as const,
  request: { params: IdParam, body: { ...json(reviewStoreSchema), required: true } },
  responses: {
    200: json(z.object({ store: AdminReviewedStoreSchema }), "Decided (or nothing to change: the current row)"),
    400: json(StoreReviewError, "Bad request (code note_required)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(
      StoreReviewError,
      "Refused against the current state (code stale | invalid_state), or an approval while the owner has an account deletion request pending or completed (code owner_leaving)"
    ),
  },
});

app.openapi(storeRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: before } = await supabaseAdmin.from("stores").select("*").eq("id", id).maybeSingle();
  if (!before) return c.json({ error: "Store not found" }, 404);

  // Only an approval depends on it; no owner = nobody leaving.
  const leaving = body.status === "active" && !!before.owner_id && (await isLeavingBlink(before.owner_id));
  const decision = resolveStaffStoreReview(before, body, { leaving }, { id: staff.id, now: new Date() });
  if (!decision.ok) return c.json({ error: decision.error, code: decision.code }, decision.status);
  // Nothing to change (e.g. approving a live store): no write, no notification.
  if (!decision.columns) return c.json({ store: reviewed(before) }, 200);

  const { data, error } = await supabaseAdmin
    .from("stores")
    .update(decision.columns)
    .eq("id", id)
    .eq("updated_at", before.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[store-review] store update failed: ${error.message}`);
  if (!data) return c.json(STALE, 409);

  const note = decision.columns.review_note;
  const copy = storeReviewCopy({
    name: before.name,
    from: before.status as StoreReviewStatus,
    to: decision.columns.status,
    note,
  });
  if (copy && before.owner_id) {
    await createNotification({
      userId: before.owner_id,
      role: "merchant",
      type: "alert",
      title: copy.en.title,
      description: copy.en.description,
      contentEng: copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
      href: storeReviewHref(id),
      payload: { kind: copy.kind, store_id: id, store_name: before.name, note },
      createdBy: staff.id,
    }).catch(() => null);
  }
  return c.json({ store: reviewed(data) }, 200);
});

// ─── One document: verify / reject (PATCH …/documents) ──────────────
// Same staff as the store review. The verdict is on the document's current
// value (`expected_value` = what the reviewer looked at) and stops counting
// once the merchant replaces it. Notifies the owner of a rejection, and when
// every required document is verified.
const documentRoute = createRoute({
  method: "patch",
  path: "/admin/stores/{id}/documents",
  operationId: "reviewMerchantStoreDocument",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [storeStaff] as const,
  request: { params: IdParam, body: { ...json(reviewStoreDocumentSchema), required: true } },
  responses: {
    200: json(z.object({ store: AdminReviewedStoreSchema }), "Recorded (or nothing to change: the current row)"),
    400: json(StoreDocumentReviewError, "Bad request (code note_required | document_missing)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(StoreDocumentReviewError, "The document or the store changed since the reviewer saw it (code stale)"),
  },
});

app.openapi(documentRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: before } = await supabaseAdmin.from("stores").select("*").eq("id", id).maybeSingle();
  if (!before) return c.json({ error: "Store not found" }, 404);

  const decision = resolveStoreDocumentReview(before, body, { id: staff.id, now: new Date() });
  if (!decision.ok) return c.json({ error: decision.error, code: decision.code }, decision.status);
  // Same verdict on the same value: no write, no notification.
  if (!decision.review) return c.json({ store: reviewed(before) }, 200);

  // updated_at guard: the documents verified are the ones read above.
  const { data, error } = await supabaseAdmin
    .from("stores")
    .update({ document_review: decision.review })
    .eq("id", id)
    .eq("updated_at", before.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[store-review] document review failed: ${error.message}`);
  if (!data) return c.json(STALE, 409);

  if (decision.notify && before.owner_id) {
    const reason = body.status === "rejected" ? body.reason?.trim() || null : null;
    const copy = storeDocumentCopy({ kind: decision.notify, name: before.name, document: body.document, reason });
    await createNotification({
      userId: before.owner_id,
      role: "merchant",
      type: "alert",
      title: copy.en.title,
      description: copy.en.description,
      contentEng: copy.en,
      contentFr: copy.fr,
      contentAr: copy.ar,
      href: storeReviewHref(id),
      payload:
        copy.kind === "store_document_rejected"
          ? { kind: copy.kind, store_id: id, store_name: before.name, document: body.document, note: reason }
          : { kind: copy.kind, store_id: id, store_name: before.name },
      createdBy: staff.id,
    }).catch(() => null);
  }
  return c.json({ store: reviewed(data) }, 200);
});

export default app;
