// Staff review of merchant catalogs: manual products, price suggestions and
// packs. Tagged admin-* so it stays out of the mobile client (orval skips it);
// the dashboard calls it (super_admin / commerce_admin). Decisions are checked
// against the row's current state and what the reviewer saw (`expected_*`),
// and written with optimistic concurrency (src/lib/product-review.ts,
// src/lib/pack-review.ts). Every decision notifies the store owner (copy +
// deep links: src/lib/catalog-review-copy.ts).
import { z } from "@hono/zod-openapi";
import {
  catalogReviewCopy,
  catalogReviewHref,
  packDecisionKind,
  type CatalogReviewEvent,
} from "../../lib/catalog-review-copy";
import { createNotification } from "../../lib/notifications";
import { resolveStaffPackReview } from "../../lib/pack-review";
import { resolveStaffProductReview, type StaffReviewState } from "../../lib/product-review";
import { priceAttribution, withoutPriceAttribution } from "../../lib/price-history";
import { supabaseAdmin } from "../../lib/supabase";
import { requireStaffRole } from "../../middleware/staff-roles";
import { bearer, createRoute, errorResponses, IdParam, json, router } from "../../openapi";
import { StoreProductSchema } from "../../validators/marketplace";
import { CatalogError, PackSchema, reviewPackSchema, reviewProductSchema } from "../../validators/merchant";

const app = router();

/** Same roles as the dashboard's /merchant-pricing and /packs-management. */
const catalogStaff = requireStaffRole("commerce_admin");

/** The write lost a race with another edit (the row's updated_at moved on). */
const STALE = {
  error: "This item changed while you were editing it. Reload and try again.",
  code: "stale" as const,
};

type StoreLite = { id: string; name: string; owner_id: string | null } | null;

/** One catalog decision to the store owner, as an in-app alert + push (best effort). */
function notifyOwner(
  ownerId: string,
  event: CatalogReviewEvent,
  payload: Record<string, unknown>,
  staffId: string
) {
  const { en, fr, ar } = catalogReviewCopy(event);
  return createNotification({
    userId: ownerId,
    role: "merchant",
    type: "alert",
    title: en.title,
    description: en.description,
    contentEng: en,
    contentFr: fr,
    contentAr: ar,
    href: catalogReviewHref(event),
    payload: { kind: event.kind, ...payload },
    createdBy: staffId,
  }).catch(() => null);
}

// ─── Staff: review a manual product / a price suggestion ─────────────
const productRoute = createRoute({
  method: "patch",
  path: "/admin/products/{id}/review",
  operationId: "reviewMerchantProduct",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { params: IdParam, body: { ...json(reviewProductSchema), required: true } },
  responses: {
    200: json(z.object({ product: StoreProductSchema }), "Decided (or nothing to change: the current row)"),
    400: json(CatalogError, "Bad request (code note_required)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(CatalogError, "Refused against the current state (code stale | not_pending | no_suggestion)"),
  },
});

app.openapi(productRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: row } = await supabaseAdmin
    .from("store_products")
    .select("*, store:stores(id, name, owner_id)")
    .eq("id", id)
    .maybeSingle();
  if (!row) return c.json({ error: "Product not found" }, 404);
  const { store, ...product } = row as Record<string, any> & { store: StoreLite };

  const review = resolveStaffProductReview(product as StaffReviewState, body);
  if (!review.ok) return c.json({ error: review.error, code: review.code }, review.status);
  // Nothing to change (e.g. approving an approved product): no write, no notification.
  if (Object.keys(review.columns).length === 0) return c.json({ product: withoutPriceAttribution(product) as any }, 200);

  const { data, error } = await supabaseAdmin
    .from("store_products")
    // Accepting a suggestion moves the live price: log it as staff's.
    .update({ ...review.columns, ...priceAttribution(review.columns, "staff", staff.id) })
    .eq("id", id)
    .eq("updated_at", product.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[catalog-review] product update failed: ${error.message}`);
  if (!data) return c.json(STALE, 409);

  if (store?.owner_id) {
    const note = (review.columns.review_note as string | null | undefined) ?? null;
    const suggested = product.suggested_price != null ? Number(product.suggested_price) : null;
    const base = {
      product_id: product.id,
      store_id: store.id,
      store_name: store.name,
      suggested_price: suggested,
    };
    for (const kind of review.decisions) {
      const event: CatalogReviewEvent =
        kind === "price_accepted"
          ? { kind, product_id: product.id, product: product.title, price: Number(data.price) }
          : kind === "pricing_flagged"
            ? { kind, product_id: product.id, product: product.title, suggested, price: Number(data.price), note }
            : kind === "product_rejected"
              ? { kind, product_id: product.id, product: product.title, store: store.name, note }
              : { kind, product_id: product.id, product: product.title, store: store.name };
      await notifyOwner(
        store.owner_id,
        event,
        {
          ...base,
          price: Number(data.price),
          note: kind === "product_rejected" || kind === "pricing_flagged" ? note : null,
        },
        staff.id
      );
    }
  }
  return c.json({ product: withoutPriceAttribution(data) }, 200);
});

// ─── Staff: approve / reject / deactivate a pack ─────────────────────
// active → approves a pack in review (reviewed_at = now, note cleared);
// inactive → rejects one in review or takes a live one down (reviewed_at
// cleared, the mandatory note kept as the pack's review_note).
const packRoute = createRoute({
  method: "patch",
  path: "/admin/packs/{id}/status",
  operationId: "reviewMerchantPack",
  tags: ["admin-merchant"],
  security: bearer,
  middleware: [catalogStaff] as const,
  request: { params: IdParam, body: { ...json(reviewPackSchema), required: true } },
  responses: {
    200: json(z.object({ pack: PackSchema })),
    400: json(CatalogError, "Bad request (code note_required)"),
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: json(CatalogError, "Refused against the current state (code stale | invalid_state)"),
  },
});

app.openapi(packRoute, async (c) => {
  const staff = c.get("user");
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");

  const { data: before } = await supabaseAdmin
    .from("store_packs")
    .select("id, name, status, review_note, updated_at, store:stores(id, name, owner_id)")
    .eq("id", id)
    .maybeSingle();
  if (!before) return c.json({ error: "Pack not found" }, 404);

  const decision = resolveStaffPackReview(before, body);
  if (!decision.ok) return c.json({ error: decision.error, code: decision.code }, decision.status);
  const { status, review_note: reviewNote } = decision.columns;

  const { data, error } = await supabaseAdmin
    .from("store_packs")
    .update(decision.columns)
    .eq("id", id)
    .eq("updated_at", before.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`[catalog-review] pack update failed: ${error.message}`);
  if (!data) return c.json(STALE, 409);

  const store = (before as unknown as { store: StoreLite }).store;
  const kind = packDecisionKind(before, { status, note: reviewNote });
  if (kind && store?.owner_id) {
    const event: CatalogReviewEvent =
      kind === "pack_approved"
        ? { kind, pack_id: data.id, pack: data.name, store: store.name }
        : { kind, pack_id: data.id, pack: data.name, store: store.name, note: reviewNote };
    await notifyOwner(
      store.owner_id,
      event,
      { pack_id: data.id, store_id: store.id, store_name: store.name, note: kind === "pack_approved" ? null : reviewNote },
      staff.id
    );
  }
  return c.json({ pack: data }, 200);
});

export default app;
