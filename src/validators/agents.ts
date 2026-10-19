import { z } from "@hono/zod-openapi";
import { agentDuesPayments } from "../db/schema";
import { rowSchema } from "../openapi";
import { AgentProfileSchema, AgentShopSchema } from "./auth";

export { AgentDocumentsSchema } from "./auth";
import { documentsSchema, weekHoursSchema } from "./merchant";

// ─── Shops ───────────────────────────────────────────────────────────

const hhmm = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, "Expected HH:MM");

const shopFields = {
  shop_name: z.string().trim().min(1),
  phone_number: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  shop_image_url: z.string().nullable().optional(),
  open_time: hhmm.optional(),
  close_time: hhmm.optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  address: z.string().nullable().optional(),
  hours: weekHoursSchema.nullable().optional(),
  documents: documentsSchema.optional(),
};

export const createAgentShopSchema = z.object(shopFields).openapi("CreateAgentShopBody");

export const updateShopSchema = z
  .object({
    ...shopFields,
    shop_name: shopFields.shop_name.optional(),
    status: z.enum(["open", "closed"]).optional(),
    manual_override: z.boolean().optional(),
    /** Make this the agent's primary shop (the previous primary is demoted). */
    is_primary: z.literal(true).optional(),
  })
  .openapi("UpdateAgentShopBody");

/** A shop as the agent manages it — row plus processed-volume stats. */
export const AgentManagedShopSchema = AgentShopSchema.extend({
  /** Cash volume of completed operations processed through this shop. */
  total_volume: z.number(),
  operations_count: z.number().int(),
}).openapi("AgentManagedShop");

export const AgentShopListResponse = z
  .object({ shops: z.array(AgentManagedShopSchema) })
  .openapi("AgentShopListResponse");

export const AgentManagedShopResponse = z
  .object({ shop: AgentManagedShopSchema })
  .openapi("AgentManagedShopResponse");

export const nearbyAgentsQuery = z.object({
  lat: z.coerce
    .number()
    .openapi({ type: "number", param: { name: "lat", in: "query", required: true } }),
  lng: z.coerce
    .number()
    .openapi({ type: "number", param: { name: "lng", in: "query", required: true } }),
});

/** Agent shop with its owner embedded (PostgREST `users!inner(...)` join). */
export const NearbyAgentSchema = AgentShopSchema.extend({
  users: z.object({
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    profile_picture: z.string().nullable(),
  }),
  /** Straight-line distance from the query point. */
  distance_km: z.number().optional(),
}).openapi("NearbyAgent");

export const NearbyAgentsResponse = z
  .object({ agents: z.array(NearbyAgentSchema) })
  .openapi("NearbyAgentsResponse");

export const AgentShopResponse = z
  .object({ shop: AgentShopSchema })
  .openapi("AgentShopResponse");

// ─── Profile (business documents + stats) ────────────────────────────

export const AgentStatsSchema = z
  .object({
    deposits_volume: z.number(),
    withdrawals_volume: z.number(),
    deposits_count: z.number().int(),
    withdrawals_count: z.number().int(),
    /** Average rider rating of this agent's operations; 0 when unrated. */
    rating: z.number(),
    ratings_count: z.number().int(),
  })
  .openapi("AgentStats");

export const AgentProfileResponse = z
  .object({
    profile: AgentProfileSchema,
    stats: AgentStatsSchema,
  })
  .openapi("AgentProfileResponse");

export const updateAgentProfileSchema = z
  .object({
    nif: z.string().trim().optional(),
    nis: z.string().trim().optional(),
    /** Uploaded file URL (POST /agents/uploads); re-uploading resets review. */
    commercial_register_front_url: z.string().url().optional(),
    commercial_register_back_url: z.string().url().optional(),
  })
  .openapi("UpdateAgentProfileBody");

// ─── Staff review (admin-agents tag; excluded from the app client) ───

export const reviewAgentShopSchema = z
  .object({ review_status: z.enum(["under_review", "active", "rejected"]) })
  .openapi("ReviewAgentShopBody");

export const reviewAgentDocumentSchema = z
  .object({
    document: z.enum(["commercial_register_front", "commercial_register_back"]),
    status: z.enum(["verified", "rejected"]),
    reason: z.string().max(300).optional(),
  })
  .openapi("ReviewAgentDocumentBody");

// ─── Required actions (activation checklist) ─────────────────────────

export const AgentRequiredActionSchema = z
  .object({
    key: z.enum(["commercial_register", "tax_ids", "personal_info", "shop_setup", "blink_cash_pin"]),
    status: z.enum(["done", "missing_info", "in_progress", "rejected"]),
    /** Which pieces are missing (e.g. ["bank_rib"], ["nis"], ["back"]). */
    missing: z.array(z.string()),
    reason: z.string().nullable(),
  })
  .openapi("AgentRequiredAction");

export const AgentRequiredActionsResponse = z
  .object({
    actions: z.array(AgentRequiredActionSchema),
    completed: z.number().int(),
    total: z.number().int(),
  })
  .openapi("AgentRequiredActionsResponse");

// ─── Uploads ─────────────────────────────────────────────────────────

export const agentUploadSchema = z
  .object({
    base64: z.string().min(1),
    content_type: z.string().min(1),
    kind: z.enum(["image", "document"]).default("image"),
  })
  .openapi("AgentUploadBody");

export const AgentUploadResponse = z.object({ url: z.string() }).openapi("AgentUploadResponse");

// ─── Dues (Blink Cash) ───────────────────────────────────────────────

export const AgentDuesPaymentSchema = rowSchema(agentDuesPayments, "AgentDuesPayment");

export const AgentDuesResponse = z
  .object({
    /** Cash the agent owes Blink right now (0 when in credit). */
    total_dues: z.number(),
    /** Surplus in the agent's favour (overpayment, or Blink owing them). */
    credit: z.number(),
    platform_fee_rate: z.number(),
    tax_rate: z.number(),
    payment_fee_rate: z.number(),
    /** Most cash the agent may hold for Blink: their own limit, else the Blink Cash default. */
    credit_limit: z.number(),
    /** Room left under the limit (credit_limit - total_dues, never negative). */
    capacity: z.number(),
    breakdown: z
      .object({
        deposits: z.number(),
        withdrawals: z.number(),
        platform_fees: z.number(),
        taxes: z.number(),
        challenge_rewards: z.number(),
        payments: z.number(),
      })
      .openapi("AgentDuesBreakdown"),
    payments: z.array(AgentDuesPaymentSchema),
  })
  .openapi("AgentDuesResponse");

export const payAgentDuesSchema = z
  .object({
    amount: z.number().positive().max(10_000_000),
    method: z.string().min(1),
    pin: z.string().regex(/^\d{4,6}$/),
  })
  .openapi("PayAgentDuesBody");

export const PayAgentDuesResponse = z
  .object({ payment: AgentDuesPaymentSchema })
  .openapi("PayAgentDuesResponse");

// ─── Perks ───────────────────────────────────────────────────────────

export const AgentBenefitSchema = z
  .object({
    id: z.string(),
    partner_name: z.string(),
    offer_text: z.string(),
    offer_title: z.string(),
    subtext: z.string().nullable(),
    category: z.enum(["supplies", "telecom", "other"]),
    image_url: z.string().nullable(),
    about_text: z.string().nullable(),
    redeem_steps: z.array(z.string()),
    terms: z.array(z.string()),
    phone: z.string().nullable(),
    location: z.string().nullable(),
    valid_until: z.string().nullable(),
  })
  .openapi("AgentBenefit");

export const AgentBenefitListResponse = z
  .object({ benefits: z.array(AgentBenefitSchema) })
  .openapi("AgentBenefitListResponse");
export const AgentBenefitResponse = z
  .object({ benefit: AgentBenefitSchema })
  .openapi("AgentBenefitResponse");

export const AgentChallengeSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    image_url: z.string().nullable(),
    rules: z.string(),
    reward_amount: z.number(),
    /** Only this kind of operation counts; null = deposits and withdrawals. */
    operation_type: z.enum(["deposit", "withdrawal"]).nullable(),
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
  .openapi("AgentChallenge");

export const AgentChallengeListResponse = z
  .object({ challenges: z.array(AgentChallengeSchema) })
  .openapi("AgentChallengeListResponse");
export const AgentChallengeResponse = z
  .object({ challenge: AgentChallengeSchema })
  .openapi("AgentChallengeResponse");
