// Staff review of a rider's verification documents. Tagged admin-* so it
// stays out of the mobile client (orval skips it); the dashboard calls it
// (Become a Partner piece 4). `{id}` is the rider's user id.
import { z } from "@hono/zod-openapi";
import { releaseRiderRequests } from "../../lib/dispatch";
import { createNotification } from "../../lib/notifications";
import {
  applyReview,
  reviewNoticeKind,
  type ReviewNoticeKind,
  type RiderDocumentKey,
} from "../../lib/rider-verification";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, IdParam, json, router } from "../../openapi";
import { reviewRiderDocumentSchema, RiderDocumentsResponse, RiderStaleReviewError } from "../../validators/riders";
import {
  documentsView,
  loadRiderVerification,
  RiderDataUnavailableError,
  writeRiderDocumentsCAS,
} from "./verification-shared";

const DocumentsConflict = z.object({ error: z.string(), code: z.literal("documents_conflict") });

const app = router();

const DOC_LABELS: Record<RiderDocumentKey, { en: string; fr: string; ar: string }> = {
  license_front: { en: "driving licence (front)", fr: "permis de conduire (recto)", ar: "رخصة القيادة (الوجه الأمامي)" },
  license_back: { en: "driving licence (back)", fr: "permis de conduire (verso)", ar: "رخصة القيادة (الوجه الخلفي)" },
  id_front: { en: "national ID (front)", fr: "carte d'identité (recto)", ar: "بطاقة التعريف الوطنية (الوجه الأمامي)" },
  id_back: { en: "national ID (back)", fr: "carte d'identité (verso)", ar: "بطاقة التعريف الوطنية (الوجه الخلفي)" },
};

function noticeCopy(kind: ReviewNoticeKind, doc: RiderDocumentKey, note: string | null) {
  const l = DOC_LABELS[doc];
  switch (kind) {
    case "approved":
      return {
        title: "You're verified",
        description: "Your documents are approved — you can go online and take jobs.",
        contentFr: {
          title: "Compte vérifié",
          description: "Vos documents sont approuvés — vous pouvez passer en ligne et accepter des courses.",
        },
        contentAr: {
          title: "تم التحقق من حسابك",
          description: "تمت الموافقة على وثائقك — يمكنك الآن الاتصال وقبول الطلبات.",
        },
      };
    case "document_rejected":
      return {
        title: "Document needs attention",
        description: note ? `Your ${l.en} was not accepted: ${note}` : `Your ${l.en} was not accepted. Please upload it again.`,
        contentFr: {
          title: "Document à revoir",
          description: note
            ? `Votre ${l.fr} n'a pas été accepté : ${note}`
            : `Votre ${l.fr} n'a pas été accepté. Veuillez le téléverser à nouveau.`,
        },
        contentAr: {
          title: "وثيقة تحتاج إلى مراجعة",
          description: note ? `لم يتم قبول ${l.ar}: ${note}` : `لم يتم قبول ${l.ar}. يرجى رفعها مرة أخرى.`,
        },
      };
    default:
      return {
        title: "Document verified",
        description: `Your ${l.en} was verified.`,
        contentFr: { title: "Document vérifié", description: `Votre ${l.fr} a été vérifié.` },
        contentAr: { title: "تم التحقق من الوثيقة", description: `تم التحقق من ${l.ar}.` },
      };
  }
}

// ─── Staff: verify / reject one rider document ───────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/riders/{id}/documents",
    operationId: "reviewRiderDocument",
    tags: ["admin-riders"],
    security: bearer,
    middleware: [requireStaff()] as const,
    request: { params: IdParam, body: { ...json(reviewRiderDocumentSchema), required: true } },
    responses: {
      200: json(RiderDocumentsResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(z.union([RiderStaleReviewError, DocumentsConflict]), "Stale review or concurrent change"),
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const { id: userId } = c.req.valid("param");
    const { document, status, note, path } = c.req.valid("json");
    const unavailable = () => c.json({ error: "Service unavailable, please retry" }, 503);
    try {
      let current = await loadRiderVerification(userId);
      if (!current) return c.json({ error: "Rider not found" }, 404);

      // Compare-and-swap; on a lost race reload, re-apply and retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = applyReview(current, document, { status, note, path });
        if (!res.ok) {
          if (res.error === "stale") {
            return c.json({ error: "The rider replaced this document, reload and review again", code: "stale_review" as const }, 409);
          }
          return c.json({ error: "Document not uploaded" }, 400);
        }
        // Same decision already recorded: no write, no second notification.
        if (res.unchanged) return c.json(await documentsView(current), 200);

        const next = res.state;
        const write = await writeRiderDocumentsCAS(userId, current.documents, next.documents, next.verification_status);
        if (write === "error") return unavailable();
        if (write === "conflict") {
          if (attempt === 0) {
            const reloaded = await loadRiderVerification(userId);
            if (!reloaded) return c.json({ error: "Rider not found" }, 404);
            current = reloaded;
          }
          continue;
        }

        // Written. A rider who is no longer approved can't stay online.
        if (next.verification_status !== "approved") {
          await supabaseAdmin.from("rider_profiles").update({ is_available: false }).eq("user_id", userId);
          await releaseRiderRequests(userId).catch(() => {});
        }
        const kind = reviewNoticeKind(current.verification_status, next.verification_status, status);
        await createNotification({
          userId,
          role: "rider",
          type: "alert",
          ...noticeCopy(kind, document, next.documents[document]?.note ?? null),
          href: "/(rider)/profile/required-actions",
        }).catch(() => {});
        return c.json(await documentsView(next), 200);
      }
      return c.json({ error: "Documents changed concurrently, please retry", code: "documents_conflict" as const }, 409);
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return unavailable();
      throw e;
    }
  }
);

export default app;
