// Staff pack editor: create, edit and delete a store's packs on its behalf,
// from the dashboard (super_admin / commerce_admin). Tagged admin-* so it
// stays out of the mobile client (orval skips it). A staff write is its own
// review — it never sends a pack to review — and edits are checked against
// what the editor saw (`expected_updated_at`) and written with optimistic
// concurrency (rules: src/lib/pack-admin.ts). Every write notifies the store
// owner (copy + deep links: src/lib/catalog-review-copy.ts) — turning on a
// pack that waited in review sends the review's approval. Approving /
// rejecting a pack the merchant sent for review stays in
// admin-catalog-review.ts.
import type { PackItem } from "../../db/schema/merchant";
import { catalogReviewCopy, catalogReviewHref, type CatalogReviewEvent } from "../../lib/catalog-review-copy";
import { createNotification } from "../../lib/notifications";
import {
  adminPackUpdateKind,
  changedPackFields,
  duplicateItems,
  foreignItems,
  foundRow,
  hasEditableField,
  isStale,
  newAdminPackColumns,
  normalizePackItems,
  resolveAdminPackUpdate,
  type AdminPackFailure,
} from "../../lib/pack-admin";
import { changedColumns, type PackStatus } from "../../lib/pack-review";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, IdParam, json, OkSchema, router } from "../../openapi";
import { PackResponse } from "../../validators/merchant";
import {
  AdminPackError,
  adminCreatePackSchema,
  adminDeletePackQuery,
  adminUpdatePackSchema,
} from "../../validators/merchant-admin-packs";

const app = router();

/** Same roles as the dashboard's /packs-management. */
const catalogStaff = requireStaffRole("commerce_admin");

/** The write lost a race with another edit (the row's updated_at moved on). */
const STALE = {
  error: "This pack changed while you were editing it. Reload and try again.",
  code: "stale" as const,
};
const EMPTY = { error: "Nothing to update", code: "empty" as const };
const notFound = (what: "Store" | "Pack") => ({ error: `${what} not found`, code: "not_found" as const });

type StoreLite = { id: string; name: string; owner_id: string | null } | null;

type StaffPackEdit = Extract<
  CatalogReviewEvent["kind"],
  "pack_created_by_staff" | "pack_updated_by_staff" | "pack_deleted_by_staff" | "pack_approved"
>;

/**
 * A staff pack edit to the store owner, as an in-app alert + push. Not
 * awaited: the write is done, and a slow push provider mustn't hold the
 * response (the dashboard would time out, report a failure and retry it).
 * Best effort: a failure is logged, never thrown.
 */
function notifyOwner(store: StoreLite, kind: StaffPackEdit, pack: { id: string; name: string }, staffId: string) {
  const ownerId = store?.owner_id;
  if (!store || !ownerId) return;
  const send = async () => {
    const event: CatalogReviewEvent = { kind, pack_id: pack.id, pack: pack.name, store: store.name };
    const { en, fr, ar } = catalogReviewCopy(event);
    await createNotification({
      userId: ownerId,
      role: "merchant",
      type: "alert",
      title: en.title,
      description: en.description,
      contentEng: en,
      contentFr: fr,
      contentAr: ar,
      href: catalogReviewHref(event),
      payload: { kind, pack_id: pack.id, pack_name: pack.name, store_id: store.id, store_name: store.name },
      createdBy: staffId,
    });
  };
  void send().catch((err) => {
    console.error(`[admin-packs] ${kind} notification failed:`, err instanceof Error ? err.message : err);
  });
}

/** Why the items are refused (a product listed twice, or not the store's), else null. */
async function checkItems(storeId: string, items: PackItem[]): Promise<AdminPackFailure | null> {
  const dupes = duplicateItems(items);
  if (dupes) return dupes;
  const { data, error } = await supabaseAdmin
    .from("store_products")
    .select("id")
    .eq("store_id", storeId)
    .in("id", items.map((i) => i.product_id));
  if (error) throw new Error(`[admin-packs] product lookup failed: ${error.message}`);
  return foreignItems(items, (data ?? []).map((p) => p.id as string));
}

/** The 400 body of a refused write. */
const refusal = ({ error, code, details }: AdminPackFailure) => ({ error, code, ...(details ? { details } : {}) });

// ─── Staff: create a pack for a store ────────────────────────────────
const createPackRoute = createRoute({
  method: "post",
  path: "/admin/stores/{id}/packs",
  operationId: "createPackAdmin",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { params: IdParam, body: { ...json(adminCreatePackSchema), required: true } },
  responses: {
    201: json(PackResponse, "Created"),
    400: json(AdminPackError, "Bad request (code duplicate_items | invalid_items)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: json(AdminPackError, "No such store (code not_found)"),
  },
});

app.openapi(createPackRoute, async (c) => {
  const staff = c.get("user");
  const { id: storeId } = c.req.valid("param");
  const { status, ...body } = c.req.valid("json");

  const store = foundRow(
    await supabaseAdmin.from("stores").select("id, name, owner_id").eq("id", storeId).maybeSingle(),
    "store"
  );
  if (!store) return c.json(notFound("Store"), 404);

  const items = normalizePackItems(body.items);
  const refused = await checkItems(store.id, items);
  if (refused) return c.json(refusal(refused), 400);

  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .insert({
      ...body,
      description: body.description ?? null,
      image: body.image ?? null,
      items,
      store_id: store.id,
      ...newAdminPackColumns(status, body.free_delivery),
    })
    .select()
    .single();
  if (error || !data) throw new Error(`[admin-packs] pack insert failed: ${error?.message ?? "no row"}`);

  notifyOwner(store, "pack_created_by_staff", data, staff.id);
  return c.json({ pack: data }, 201);
});

// ─── Staff: edit a pack ──────────────────────────────────────────────
// Fields left out stay as they are; a form saved without changes writes
// nothing (200, the current row, no notification).
const updatePackRoute = createRoute({
  method: "patch",
  path: "/admin/packs/{id}",
  operationId: "updatePackAdmin",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { params: IdParam, body: { ...json(adminUpdatePackSchema), required: true } },
  responses: {
    200: json(PackResponse, "Updated (or nothing to change: the current row)"),
    400: json(AdminPackError, "Bad request (code empty | duplicate_items | invalid_items)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: json(AdminPackError, "No such pack (code not_found)"),
    409: json(AdminPackError, "The pack changed since it was read (code stale) — reload and retry"),
  },
});

app.openapi(updatePackRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const { expected_updated_at: expected, ...edit } = c.req.valid("json");
  if (!hasEditableField(edit)) return c.json(EMPTY, 400);

  const row = foundRow(
    await supabaseAdmin.from("store_packs").select("*, store:stores(id, name, owner_id)").eq("id", id).maybeSingle(),
    "pack"
  );
  if (!row) return c.json(notFound("Pack"), 404);
  const { store, ...pack } = row as Record<string, any> & { store: StoreLite };
  if (isStale(pack.updated_at, expected)) return c.json(STALE, 409);

  const items = edit.items ? normalizePackItems(edit.items) : undefined;
  if (items) {
    const refused = await checkItems(pack.store_id, items);
    if (refused) return c.json(refusal(refused), 400);
  }

  const fields = changedPackFields(pack, { ...edit, items });
  if (Object.keys(fields).length === 0) return c.json({ pack: pack as any }, 200);
  const current = pack as { status: PackStatus; free_delivery: boolean };
  const review = changedColumns(pack, resolveAdminPackUpdate(current, edit));

  // Optimistic concurrency: only write over the row the rules were applied to.
  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .update({ ...fields, ...review })
    .eq("id", id)
    .eq("updated_at", pack.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[admin-packs] pack update failed: ${error.message}`);
  if (!data) return c.json(STALE, 409);

  notifyOwner(store, adminPackUpdateKind(current, data), data, staff.id);
  return c.json({ pack: data }, 200);
});

// ─── Staff: delete a pack ────────────────────────────────────────────
// A hard delete, like the merchant's: order lines keep their own snapshot.
const deletePackRoute = createRoute({
  method: "delete",
  path: "/admin/packs/{id}",
  operationId: "deletePackAdmin",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { params: IdParam, query: adminDeletePackQuery },
  responses: {
    200: json(OkSchema),
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: json(AdminPackError, "No such pack (code not_found)"),
    409: json(AdminPackError, "The pack changed since it was read (code stale) — reload and retry"),
  },
});

app.openapi(deletePackRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const { expected_updated_at: expected } = c.req.valid("query");

  const row = foundRow(
    await supabaseAdmin
      .from("store_packs")
      .select("id, name, updated_at, store:stores(id, name, owner_id)")
      .eq("id", id)
      .maybeSingle(),
    "pack"
  );
  if (!row) return c.json(notFound("Pack"), 404);
  if (isStale(row.updated_at, expected)) return c.json(STALE, 409);

  // With an expected timestamp, only delete the row the editor saw.
  let query = supabaseAdmin.from("store_packs").delete().eq("id", id);
  if (expected !== undefined) query = query.eq("updated_at", row.updated_at);
  const { data: deleted, error } = await query.select("id");
  if (error) throw new Error(`[admin-packs] pack delete failed: ${error.message}`);
  if (!deleted?.length) return expected !== undefined ? c.json(STALE, 409) : c.json(notFound("Pack"), 404);

  const store = (row as unknown as { store: StoreLite }).store;
  notifyOwner(store, "pack_deleted_by_staff", row, staff.id);
  return c.json({ success: true }, 200);
});

export default app;
