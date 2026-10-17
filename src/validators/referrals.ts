import { z } from "@hono/zod-openapi";

export const applyReferralSchema = z
  .object({
    code: z.string().trim().min(1, "Referral code is required"),
  })
  .openapi("ApplyReferralBody");

export const ReferralItemSchema = z
  .object({
    id: z.string(),
    friend_name: z.string(),
    friend_phone: z.string(),
    status: z.enum(["completed", "pending", "cancelled"]),
    reward: z.number(),
    date: z.string(),
    service: z.string(),
    claimed: z.boolean(),
  })
  .openapi("ReferralItem");

export const ReferralStatsSchema = z
  .object({
    total_earned: z.number(),
    successful_referrals: z.number(),
    pending_invites: z.number(),
    available_balance: z.number(),
  })
  .openapi("ReferralStats");

export const AppliedReferralSchema = z
  .object({
    code: z.string(),
    discount_amount: z.number(),
    applied_at: z.string(),
  })
  .openapi("AppliedReferral");

export const ReferralOverviewResponse = z
  .object({
    referral_code: z.string(),
    invite_url: z.string(),
    reward_amount: z.number(),
    currency: z.string(),
    stats: ReferralStatsSchema,
    referrals: z.array(ReferralItemSchema),
    applied_referral: AppliedReferralSchema.nullable(),
  })
  .openapi("ReferralOverviewResponse");

export const ApplyReferralResponse = z
  .object({
    success: z.boolean(),
    discount_amount: z.number(),
    coupon_code: z.string().optional(),
  })
  .openapi("ApplyReferralResponse");
