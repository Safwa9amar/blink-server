// Rider: invitations from merchants to join their store's own riders.
import { createNotification } from "../../lib/notifications";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import {
  respondInvitationSchema,
  StoreInvitationListResponse,
} from "../../validators/merchant";

const app = router();

app.openapi(
  createRoute({
    method: "get",
    path: "/store-invitations",
    operationId: "listRiderStoreInvitations",
    tags: ["riders"],
    security: bearer,
    responses: {
      200: json(StoreInvitationListResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { data } = await supabaseAdmin
      .from("store_drivers")
      .select("id, store_id, status, created_at, store:stores(name, image, location)")
      .eq("rider_user_id", user.id)
      .in("status", ["invited", "active"])
      .order("created_at", { ascending: false });
    return c.json(
      {
        invitations: (data ?? []).map((d: any) => ({
          id: d.id,
          store_id: d.store_id,
          store_name: d.store?.name ?? "",
          store_image: d.store?.image ?? "",
          store_address: d.store?.location ?? null,
          status: d.status,
          created_at: d.created_at,
        })),
      },
      200
    );
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/store-invitations/{id}/respond",
    operationId: "respondRiderStoreInvitation",
    tags: ["riders"],
    security: bearer,
    request: { params: IdParam, body: { ...json(respondInvitationSchema), required: true } },
    responses: {
      200: json(StoreInvitationListResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { accept } = c.req.valid("json");
    const { data: inv } = await supabaseAdmin
      .from("store_drivers")
      .select("id, status, full_name, store:stores(name, owner_id)")
      .eq("id", id)
      .eq("rider_user_id", user.id)
      .maybeSingle();
    if (!inv) return c.json({ error: "Invitation not found" }, 404);
    if (inv.status !== "invited") return c.json({ error: "Invitation already answered" }, 400);

    await supabaseAdmin
      .from("store_drivers")
      .update({ status: accept ? "active" : "declined" })
      .eq("id", id);

    const store = (inv as any).store;
    if (store?.owner_id) {
      await createNotification({
        userId: store.owner_id,
        type: "alert",
        title: accept ? "Rider joined your team" : "Invitation declined",
        description: accept
          ? `${inv.full_name} can now deliver for ${store.name}.`
          : `${inv.full_name} declined to deliver for ${store.name}.`,
        contentFr: {
          title: accept ? "Un livreur a rejoint votre équipe" : "Invitation refusée",
          description: accept
            ? `${inv.full_name} peut maintenant livrer pour ${store.name}.`
            : `${inv.full_name} a refusé de livrer pour ${store.name}.`,
        },
        contentAr: {
          title: accept ? "انضم مندوب إلى فريقك" : "تم رفض الدعوة",
          description: accept
            ? `${inv.full_name} يمكنه الآن التوصيل لـ ${store.name}.`
            : `رفض ${inv.full_name} التوصيل لـ ${store.name}.`,
        },
        payload: { kind: "store_driver", store_driver_id: id },
      }).catch(() => null);
    }

    const { data } = await supabaseAdmin
      .from("store_drivers")
      .select("id, store_id, status, created_at, store:stores(name, image, location)")
      .eq("rider_user_id", user.id)
      .in("status", ["invited", "active"]);
    return c.json(
      {
        invitations: (data ?? []).map((d: any) => ({
          id: d.id,
          store_id: d.store_id,
          store_name: d.store?.name ?? "",
          store_image: d.store?.image ?? "",
          store_address: d.store?.location ?? null,
          status: d.status,
          created_at: d.created_at,
        })),
      },
      200
    );
  }
);

export default app;
