// Staff review of a rider's verification documents. Tagged admin-* so it
// stays out of the mobile client (orval skips it); the dashboard calls it
// (Become a Partner piece 4). `{id}` is the rider's user id.
import { z } from "@hono/zod-openapi";
import { releaseRiderRequests } from "../../lib/dispatch";
import { createNotification } from "../../lib/notifications";
import { releaseBookedJobs } from "../../lib/rider-release";
import {
  applyReview,
  applyVerificationRequest,
  requiredDocumentKeys,
  reviewNoticeKind,
  statusAfterVerificationRequest,
  type ReviewNoticeKind,
  type RiderDocumentKey,
} from "../../lib/rider-verification";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff } from "../../middleware/auth";
import {
  bearer,
  createRoute,
  ErrorSchema,
  errorResponses,
  json,
  router,
} from "../../openapi";
import {
  RequestRiderVerificationResponse,
  requestRiderVerificationSchema,
  reviewRiderDocumentSchema,
  RiderDocumentsConflict,
  RiderDocumentsResponse,
  RiderStaleReviewError,
} from "../../validators/riders";
import {
  documentsView,
  loadRiderVerification,
  RiderDataUnavailableError,
  writeRiderDocumentsCAS,
} from "./verification-shared";

const app = router();

const DOC_LABELS: Record<
  RiderDocumentKey,
  { en: string; fr: string; ar: string; frFem: boolean }
> = {
  license_front: {
    en: "driving licence (front)",
    fr: "permis de conduire (recto)",
    ar: "رخصة القيادة (الوجه الأمامي)",
    frFem: false,
  },
  license_back: {
    en: "driving licence (back)",
    fr: "permis de conduire (verso)",
    ar: "رخصة القيادة (الوجه الخلفي)",
    frFem: false,
  },
  id_front: {
    en: "national ID (front)",
    fr: "carte d'identité (recto)",
    ar: "بطاقة التعريف الوطنية (الوجه الأمامي)",
    frFem: true,
  },
  id_back: {
    en: "national ID (back)",
    fr: "carte d'identité (verso)",
    ar: "بطاقة التعريف الوطنية (الوجه الخلفي)",
    frFem: true,
  },
  gray_card_front: {
    en: "gray card (front)",
    fr: "carte grise (recto)",
    ar: "البطاقة الرمادية (الوجه)",
    frFem: true,
  },
  gray_card_back: {
    en: "gray card (back)",
    fr: "carte grise (verso)",
    ar: "البطاقة الرمادية (الظهر)",
    frFem: true,
  },
  insurance: {
    en: "insurance certificate",
    fr: "attestation d'assurance",
    ar: "شهادة التأمين",
    frFem: true,
  },
};

function noticeCopy(
  kind: ReviewNoticeKind,
  doc: RiderDocumentKey,
  note: string | null,
  wasApproved = false,
) {
  const l = DOC_LABELS[doc];
  const e = l.frFem ? "e" : "";
  const pronoun = l.frFem ? "la" : "le";
  const offline = {
    en: " You're now offline and can't take jobs until you re-upload it and it's approved.",
    fr: ` Vous êtes maintenant hors ligne et ne pouvez plus accepter de courses jusqu'à ce que vous ${pronoun} téléversiez à nouveau et qu'${l.frFem ? "elle" : "il"} soit approuvé${e}.`,
    ar: " أصبحت الآن غير متصل ولا يمكنك قبول الطلبات حتى تعيد رفعها ويتم قبولها.",
  };
  switch (kind) {
    case "approved":
      return {
        title: "You're verified",
        description:
          "Your documents are approved — you can go online and take jobs.",
        contentFr: {
          title: "Compte vérifié",
          description:
            "Vos documents sont approuvés — vous pouvez passer en ligne et accepter des courses.",
        },
        contentAr: {
          title: "تم التحقق من حسابك",
          description:
            "تمت الموافقة على وثائقك — يمكنك الآن الاتصال وقبول الطلبات.",
        },
      };
    case "document_rejected":
      return {
        title: "Document needs attention",
        description:
          (note
            ? `Your ${l.en} was not accepted: ${note}`
            : `Your ${l.en} was not accepted. Please upload it again.`) +
          (wasApproved ? offline.en : ""),
        contentFr: {
          title: "Document à revoir",
          description:
            (note
              ? `Votre ${l.fr} n'a pas été accepté${e} : ${note}`
              : `Votre ${l.fr} n'a pas été accepté${e}. Veuillez ${pronoun} téléverser à nouveau.`) +
            (wasApproved ? offline.fr : ""),
        },
        contentAr: {
          title: "وثيقة تحتاج إلى مراجعة",
          description:
            (note
              ? `لم يتم قبول ${l.ar}: ${note}`
              : `لم يتم قبول ${l.ar}. يرجى رفعها مرة أخرى.`) +
            (wasApproved ? offline.ar : ""),
        },
      };
    default:
      return {
        title: "Document verified",
        description: `Your ${l.en} was verified.`,
        contentFr: {
          title: "Document vérifié",
          description: `Votre ${l.fr} a été vérifié${e}.`,
        },
        contentAr: {
          title: "تم التحقق من الوثيقة",
          description: `تم التحقق من ${l.ar}.`,
        },
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
    request: {
      params: z.object({
        id: z
          .string()
          .uuid()
          .openapi({ param: { name: "id", in: "path" } }),
      }),
      body: { ...json(reviewRiderDocumentSchema), required: true },
    },
    responses: {
      200: json(RiderDocumentsResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(
        z.union([RiderStaleReviewError, RiderDocumentsConflict]),
        "Stale review or concurrent change",
      ),
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const { id: userId } = c.req.valid("param");
    const { document, status, note, path } = c.req.valid("json");
    const reviewer = { id: c.get("user").id, at: new Date().toISOString() };
    const unavailable = () =>
      c.json({ error: "Service unavailable, please retry" }, 503);
    try {
      let current = await loadRiderVerification(userId);
      if (!current) return c.json({ error: "Rider not found" }, 404);

      // Compare-and-swap; on a lost race reload, re-apply and retry once.
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = applyReview(current, document, {
          status,
          note,
          path,
          reviewer,
        }, current.vehicle_type);
        if (!res.ok) {
          if (res.error === "stale") {
            return c.json(
              {
                error:
                  "The rider replaced this document, reload and review again",
                code: "stale_review" as const,
              },
              409,
            );
          }
          return c.json({ error: "Document not uploaded" }, 400);
        }
        // Same decision already recorded: no write, no second notification.
        if (res.unchanged) return c.json(await documentsView(current, current.vehicle_type), 200);

        const next = res.state;
        const write = await writeRiderDocumentsCAS(
          userId,
          current.documents,
          next.documents,
          next.verification_status,
        );
        if (write === "error") return unavailable();
        if (write === "conflict") {
          if (attempt === 0) {
            const reloaded = await loadRiderVerification(userId);
            if (!reloaded) return c.json({ error: "Rider not found" }, 404);
            current = reloaded;
          }
          continue;
        }

        // Written. A rider who is no longer approved can't stay online, nor
        // keep the jobs they booked for later.
        if (next.verification_status !== "approved") {
          const { error: offlineErr } = await supabaseAdmin
            .from("rider_profiles")
            .update({ is_available: false })
            .eq("user_id", userId);
          if (offlineErr)
            console.error(
              `[riders] could not set rider ${userId} offline after de-approval:`,
              offlineErr.message,
            );
          await releaseRiderRequests(userId).catch(() => {});
          await releaseBookedJobs(userId);
        }
        const kind = reviewNoticeKind(
          current.verification_status,
          next.verification_status,
          status,
        );
        await createNotification({
          userId,
          role: "rider",
          type: "alert",
          ...noticeCopy(
            kind,
            document,
            next.documents[document]?.note ?? null,
            current.verification_status === "approved",
          ),
          href: "/(rider)/profile/required-actions",
        }).catch(() => {});
        return c.json(await documentsView(next, current.vehicle_type), 200);
      }
      return c.json(
        {
          error: "Documents changed concurrently, please retry",
          code: "documents_conflict" as const,
        },
        409,
      );
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return unavailable();
      throw e;
    }
  },
);

function verificationRequestCopy(
  docs: RiderDocumentKey[],
  note: string,
  wasApproved: boolean,
) {
  const join = (items: string[], and: string) =>
    items.length <= 1
      ? items.join("")
      : `${items.slice(0, -1).join(", ")} ${and} ${items[items.length - 1]}`;
  const en = join(docs.map((k) => DOC_LABELS[k].en), "and");
  const fr = join(docs.map((k) => DOC_LABELS[k].fr), "et");
  const ar = join(docs.map((k) => DOC_LABELS[k].ar), "و");
  const offline = {
    en: " You're now offline and can't take jobs until you re-upload and it's approved.",
    fr: " Vous êtes maintenant hors ligne et ne pouvez plus accepter de courses tant que vous n'avez pas téléversé à nouveau et que la vérification n'est pas approuvée.",
    ar: " أصبحت الآن غير متصل ولا يمكنك قبول الطلبات حتى تعيد الرفع وتتم الموافقة.",
  };
  return {
    title: "New verification required",
    description: `Please re-upload: ${en}. ${note}${wasApproved ? offline.en : ""}`,
    contentFr: {
      title: "Nouvelle vérification requise",
      description: `Veuillez téléverser à nouveau : ${fr}. ${note}${wasApproved ? offline.fr : ""}`,
    },
    contentAr: {
      title: "مطلوب تحقق جديد",
      description: `يرجى إعادة رفع: ${ar}. ${note}${wasApproved ? offline.ar : ""}`,
    },
  };
}

// ─── Staff: ask the rider for a new verification of some documents ───
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/riders/{id}/verification-request",
    operationId: "requestRiderVerification",
    tags: ["admin-riders"],
    security: bearer,
    middleware: [requireStaff()] as const,
    request: {
      params: z.object({
        id: z
          .string()
          .uuid()
          .openapi({ param: { name: "id", in: "path" } }),
      }),
      body: { ...json(requestRiderVerificationSchema), required: true },
    },
    responses: {
      200: json(RequestRiderVerificationResponse),
      400: json(
        z.union([
          ErrorSchema,
          z.object({ error: z.string(), code: z.literal("not_required") }),
        ]),
        "Invalid request or document not required",
      ),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: json(RiderDocumentsConflict, "Concurrent change"),
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const { id: userId } = c.req.valid("param");
    const { documents: keys, note } = c.req.valid("json");
    const reviewerId = c.get("user").id;
    const unavailable = () =>
      c.json({ error: "Service unavailable, please retry" }, 503);
    try {
      let current = await loadRiderVerification(userId);
      if (!current) return c.json({ error: "Rider not found" }, 404);

      for (let attempt = 0; attempt < 2; attempt++) {
        const required = requiredDocumentKeys(current.vehicle_type);
        if (keys.some((k) => !required.includes(k))) {
          return c.json(
            {
              error: "A requested document is not required for this vehicle",
              code: "not_required" as const,
            },
            400,
          );
        }
        const { documents, invalidated, missing } = applyVerificationRequest(
          current.documents,
          keys,
          note,
          reviewerId,
          new Date().toISOString(),
        );
        const status = statusAfterVerificationRequest(
          documents,
          current.vehicle_type,
        );
        const write = await writeRiderDocumentsCAS(
          userId,
          current.documents,
          documents,
          status,
        );
        if (write === "error") return unavailable();
        if (write === "conflict") {
          if (attempt === 0) {
            const reloaded = await loadRiderVerification(userId);
            if (!reloaded) return c.json({ error: "Rider not found" }, 404);
            current = reloaded;
          }
          continue;
        }

        const wasApproved = current.verification_status === "approved";
        if (wasApproved && status !== "approved") {
          const { error: offlineErr } = await supabaseAdmin
            .from("rider_profiles")
            .update({ is_available: false })
            .eq("user_id", userId);
          if (offlineErr)
            console.error(
              `[riders] could not set rider ${userId} offline after verification request:`,
              offlineErr.message,
            );
          await releaseRiderRequests(userId).catch(() => {});
          await releaseBookedJobs(userId);
        }
        const copy = verificationRequestCopy(
          keys,
          note,
          wasApproved,
        );
        await createNotification({
          userId,
          role: "rider",
          type: "alert",
          ...copy,
          href: "/(rider)/profile/required-actions",
        }).catch(() => {});
        return c.json(
          { verification_status: status, invalidated, missing },
          200,
        );
      }
      return c.json(
        {
          error: "Documents changed concurrently, please retry",
          code: "documents_conflict" as const,
        },
        409,
      );
    } catch (e) {
      if (e instanceof RiderDataUnavailableError) return unavailable();
      throw e;
    }
  },
);

export default app;
