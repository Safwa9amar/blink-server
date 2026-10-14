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
    status: z.enum(["active", "used", "expired", "revoked"]),
    /** Human label, e.g. "15% OFF", "500 DZD", "Free delivery". */
    discount_label: z.string(),
  })
  .openapi("Coupon");

export const trackPromotionEventsSchema = z
  .object({
    events: z
      .array(z.object({ promotion_id: z.string().uuid(), event: z.enum(["view", "tap"]) }))
      .min(1)
      .max(50),
  })
  .openapi("TrackPromotionEventsBody");

export const TrackPromotionEventsResponse = z
  .object({ accepted: z.number().int() })
  .openapi("TrackPromotionEventsResponse");

/** 409 from activate / redeem when the promotion can't issue (any more). */
export const PromotionUnavailableResponse = z
  .object({ error: z.string(), code: z.enum(["not_live", "sold_out", "budget_spent"]) })
  .openapi("PromotionUnavailableResponse");

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
