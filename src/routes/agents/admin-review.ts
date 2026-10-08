// Staff review of agent shops and business documents. Tagged admin-* so it
// stays out of the mobile client (orval skips it); the dashboard calls it.
import { z } from "@hono/zod-openapi";
import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaff } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { AgentProfileSchema, AgentShopSchema } from "../../validators/auth";
import { reviewAgentDocumentSchema, reviewAgentShopSchema } from "../../validators/agents";

const app = router();

// ─── Staff: approve / reject an agent shop ───────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/shops/{id}/review",
    operationId: "reviewAgentShop",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [requireStaff()] as const,
    request: { params: IdParam, body: { ...json(reviewAgentShopSchema), required: true } },
    responses: {
      200: json(z.object({ shop: AgentShopSchema })),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const { review_status } = c.req.valid("json");
    const { data, error } = await supabaseAdmin
      .from("agent_shops")
      .update({ review_status })
      .eq("id", id)
      .select()
      .single();
    if (error || !data) return c.json({ error: "Shop not found" }, 404);

    if (review_status !== "under_review") {
      const ok = review_status === "active";
      await createNotification({
        userId: data.user_id,
        role: "agent",
        type: "alert",
        title: ok ? "Shop approved" : "Shop not approved",
        description: ok
          ? `${data.shop_name} is verified — riders can now find it.`
          : `${data.shop_name} could not be verified. Check its details and documents.`,
        contentFr: {
          title: ok ? "Point de vente approuvé" : "Point de vente refusé",
          description: ok
            ? `${data.shop_name} est vérifié — les livreurs peuvent maintenant le trouver.`
            : `${data.shop_name} n'a pas pu être vérifié. Vérifiez ses informations et documents.`,
        },
        contentAr: {
          title: ok ? "تمت الموافقة على المتجر" : "لم تتم الموافقة على المتجر",
          description: ok
            ? `تم التحقق من ${data.shop_name} — يمكن للسائقين الآن العثور عليه.`
            : `تعذر التحقق من ${data.shop_name}. تحقق من بياناته ووثائقه.`,
        },
        href: `/(agent)/profile/my-shops/${data.id}`,
      }).catch(() => {});
    }
    return c.json({ shop: { ...data, documents: data.documents ?? {} } }, 200);
  }
);

// ─── Staff: verify / reject an agent's commercial register scan ──────
app.openapi(
  createRoute({
    method: "patch",
    path: "/admin/agents/{id}/documents",
    operationId: "reviewAgentDocument",
    tags: ["admin-agents"],
    security: bearer,
    middleware: [requireStaff()] as const,
    request: { params: IdParam, body: { ...json(reviewAgentDocumentSchema), required: true } },
    responses: {
      200: json(z.object({ profile: AgentProfileSchema })),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const { id: userId } = c.req.valid("param");
    const { document, status, reason } = c.req.valid("json");
    const { data: profile } = await supabaseAdmin
      .from("agent_profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (!profile) return c.json({ error: "Agent not found" }, 404);

    const docs = { ...(profile.documents ?? {}) };
    if (!docs[document]?.url) return c.json({ error: "Document not uploaded" }, 400);
    docs[document] = { ...docs[document], status, reason: status === "rejected" ? reason ?? null : null };

    const { data, error } = await supabaseAdmin
      .from("agent_profiles")
      .update({ documents: docs })
      .eq("user_id", userId)
      .select()
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Update failed" }, 400);

    if (status === "rejected") {
      await createNotification({
        userId,
        role: "agent",
        type: "alert",
        title: "Document needs attention",
        description: reason ?? "Please re-upload your commercial register.",
        contentFr: {
          title: "Document à revoir",
          description: reason ?? "Veuillez téléverser à nouveau votre registre de commerce.",
        },
        contentAr: {
          title: "وثيقة تحتاج إلى مراجعة",
          description: reason ?? "يرجى إعادة رفع السجل التجاري الخاص بك.",
        },
        href: "/(agent)/profile/required-actions",
      }).catch(() => {});
    }
    return c.json({ profile: { ...data, documents: data.documents ?? {} } }, 200);
  }
);

export default app;
