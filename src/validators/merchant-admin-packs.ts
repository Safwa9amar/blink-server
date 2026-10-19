// Validation schemas for the staff pack editor (POST
// /merchant/admin/stores/{id}/packs, PATCH / DELETE /merchant/admin/packs/{id}):
// tagged admin-merchant, so the dashboard calls them and the mobile client
// skips them. Responses reuse the merchant app's PackResponse
// (src/validators/merchant.ts); rules live in src/lib/pack-admin.ts.
import { z } from "@hono/zod-openapi";
import { ADMIN_PACK_ERROR_CODES } from "../lib/pack-admin";

/** An ISO timestamp as read from the row (any offset / sub-second precision). */
const isoTimestamp = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "must be an ISO timestamp" });

/** A blank text (after trimming) is stored as null, so the form can clear it. */
const blankToNull = (v: string | null) => (v === "" ? null : v);

const isHttpUrl = (v: string) => {
  try {
    return ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

export const adminPackItemSchema = z
  .object({
    product_id: z.guid().openapi({ description: "A product of the pack's store; once per pack" }),
    quantity: z.number().int().min(1).max(999),
    qty_promo_enabled: z.boolean().default(false),
    buy_qty: z.number().int().min(0).default(0).openapi({ description: "At least 1 while qty_promo_enabled" }),
    get_qty: z.number().int().min(0).default(0).openapi({ description: "At least 1 while qty_promo_enabled" }),
  })
  .superRefine((item, ctx) => {
    if (!item.qty_promo_enabled) return;
    for (const key of ["buy_qty", "get_qty"] as const) {
      if (item[key] < 1) {
        ctx.addIssue({ code: "custom", path: [key], message: "must be at least 1 when qty_promo_enabled is true" });
      }
    }
  })
  .openapi("AdminPackItem");

const packFields = {
  name: z.string().trim().min(1).max(80),
  description: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .transform(blankToNull)
    .openapi({ description: "Blank → null" }),
  image: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => v === "" || isHttpUrl(v), { message: "must be an http(s) URL" })
    .nullable()
    .transform(blankToNull)
    .openapi({ description: "Image URL; blank → null" }),
  items: z.array(adminPackItemSchema).min(1).max(30),
  discount_enabled: z.boolean(),
  discount_percent: z.number().int().min(0).max(90),
  free_delivery: z.boolean(),
};

export const adminCreatePackSchema = z
  .object({
    name: packFields.name,
    description: packFields.description.optional(),
    image: packFields.image.optional(),
    items: packFields.items,
    discount_enabled: packFields.discount_enabled.default(false),
    discount_percent: packFields.discount_percent.default(0),
    free_delivery: packFields.free_delivery.default(false),
    status: z.enum(["active", "inactive"]).default("active").openapi({
      description:
        "Staff-authored packs skip review: live (or off) right away; a live free-delivery pack is stamped approved (reviewed_at)",
    }),
  })
  .openapi("AdminCreatePackBody");

export const adminUpdatePackSchema = z
  .object({
    name: packFields.name.optional(),
    description: packFields.description.optional(),
    image: packFields.image.optional(),
    items: packFields.items.optional(),
    discount_enabled: packFields.discount_enabled.optional(),
    discount_percent: packFields.discount_percent.optional(),
    free_delivery: packFields.free_delivery.optional(),
    status: z.enum(["active", "inactive", "archived"]).optional().openapi({
      description:
        "Left out: the pack keeps its status (one waiting in review stays there). A live free-delivery result is stamped approved (reviewed_at) and a live result clears the review note",
    }),
    expected_updated_at: isoTimestamp.optional().openapi({
      description: "The pack's updated_at the editor saw: another instant → 409 code stale",
    }),
  })
  .openapi("AdminUpdatePackBody");

export const adminDeletePackQuery = z.object({
  expected_updated_at: isoTimestamp.optional().openapi({
    description: "The pack's updated_at the editor saw: another instant → 409 code stale",
  }),
});

/**
 * 400 / 404 / 409 of the staff pack editor. `code`:
 * - not_found (404): no such store / pack;
 * - duplicate_items (400): a product is listed more than once;
 * - invalid_items (400): an item isn't a product of the pack's store (`details`
 *   names each one, path `items.<index>.product_id`);
 * - empty (400): the edit changes no pack field;
 * - stale (409): the pack changed since the editor read it — reload.
 * A request-validation 400 carries `details` and no `code`.
 */
export const AdminPackError = z
  .object({
    error: z.string(),
    code: z.enum(ADMIN_PACK_ERROR_CODES).optional(),
    details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi("AdminPackError");
