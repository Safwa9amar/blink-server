// Validation + response schemas for promotions (promos + deals) and the
// customer coupons they issue.
import { z } from "@hono/zod-openapi";
import { customerCoupons, promotions } from "../db/schema";
import { rowSchema } from "../openapi";

export const listPromotionsSchema = z.object({
  kind: z.enum(["promo", "deal"]).optional(),
});

export const redeemCouponSchema = z
  .object({ code: z.string().trim().min(1) })
  .openapi("RedeemCouponBody");

// ─── Response schemas ────────────────────────────────────────────────

export const PromotionSchema = rowSchema(promotions, "PromotionRow")
  .extend({
    /** Whether the signed-in customer already holds a coupon from it. */
    is_activated: z.boolean(),
  })
  .openapi("Promotion");

export const CouponSchema = rowSchema(customerCoupons, "CouponRow")
  .extend({
    status: z.enum(["active", "used", "expired"]),
    /** Human label, e.g. "15% OFF", "500 DZD", "Free delivery". */
    discount_label: z.string(),
  })
  .openapi("Coupon");

export const PromotionListResponse = z
  .object({ promotions: z.array(PromotionSchema) })
  .openapi("PromotionListResponse");
export const PromotionResponse = z
  .object({ promotion: PromotionSchema })
  .openapi("PromotionResponse");
export const CouponListResponse = z
  .object({ coupons: z.array(CouponSchema) })
  .openapi("CouponListResponse");
export const CouponResponse = z.object({ coupon: CouponSchema }).openapi("CouponResponse");
