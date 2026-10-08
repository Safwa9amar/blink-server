import { z } from "@hono/zod-openapi";

export const RiderBenefitSchema = z
  .object({
    id: z.string(),
    partner_name: z.string(),
    offer_text: z.string(),
    offer_title: z.string(),
    subtext: z.string().nullable(),
    category: z.enum(["fuel", "maintenance", "other"]),
    image_url: z.string().nullable(),
    about_text: z.string().nullable(),
    redeem_steps: z.array(z.string()),
    terms: z.array(z.string()),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .openapi("RiderBenefit");

export const RiderBenefitListResponse = z
  .object({ benefits: z.array(RiderBenefitSchema) })
  .openapi("RiderBenefitListResponse");
export const RiderBenefitResponse = z
  .object({ benefit: RiderBenefitSchema })
  .openapi("RiderBenefitResponse");

export const RiderChallengeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    image_url: z.string().nullable(),
    rules: z.string(),
    reward_amount: z.number(),
    /** available (not joined) · ongoing (joined) · won · lost · gave_up */
    status: z.enum(["available", "ongoing", "won", "lost", "gave_up"]),
    is_new: z.boolean(),
    starts_at: z.string(),
    ends_at: z.string(),
    progress_current: z.number().int(),
    progress_target: z.number().int(),
    cancellations: z.number().int(),
    max_cancellations: z.number().int().nullable(),
  })
  .openapi("RiderChallenge");

export const RiderChallengeListResponse = z
  .object({ challenges: z.array(RiderChallengeSchema) })
  .openapi("RiderChallengeListResponse");
export const RiderChallengeResponse = z
  .object({ challenge: RiderChallengeSchema })
  .openapi("RiderChallengeResponse");
