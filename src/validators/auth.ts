import { z } from "@hono/zod-openapi";
import {
  agentProfiles,
  agentShops,
  customerProfiles,
  merchantProfiles,
  riderProfiles,
  users,
  vehicles,
} from "../db/schema";
import { rowSchema } from "../openapi";
import { documentsSchema, weekHoursSchema } from "./merchant";

export const sendOtpSchema = z
  .object({
    phone_number: z
      .string()
      .regex(/^\+\d{9,15}$/, "Phone must be in international format (e.g. +213XXXXXXXXX)"),
  })
  .openapi("SendOtpBody");

export const verifyOtpSchema = z
  .object({
    phone_number: z
      .string()
      .regex(/^\+\d{9,15}$/),
    otp: z
      .string()
      .length(6, "OTP must be 6 digits"),
  })
  .openapi("VerifyOtpBody");

export const selectRoleSchema = z
  .object({
    role: z.enum(["customer", "rider", "merchant", "agent"]),
  })
  .openapi("SelectRoleBody");

export const updateProfileSchema = z.object({
  first_name: z.string().min(1).optional(),
  last_name: z.string().min(1).optional(),
  middle_name: z.string().optional(),
  email: z.string().email().optional(),
  // International format, e.g. +213555123456. Unique across users — a duplicate
  // surfaces as a 400 from the DB.
  phone_number: z
    .string()
    .regex(/^\+\d{9,15}$/, "Phone must be in international format (e.g. +213XXXXXXXXX)")
    .optional(),
  gender: z.enum(["male", "female"]).optional(),
  birthday: z.string().optional(),
  address: z.string().optional(),
  wilaya: z.string().optional(),
  wilaya_code: z.string().optional(),
  bank_rib: z.string().optional(),
  // Public URL of an avatar already uploaded to the Supabase `avatars` bucket
  // (the mobile client uploads directly, then persists the URL here).
  profile_picture: z.string().url().optional(),
}).openapi("UpdateAuthProfileBody");

export const setupPinSchema = z
  .object({
    pin: z.string().length(4, "PIN must be 4 digits").regex(/^\d{4}$/),
  })
  .openapi("SetupPinBody");

export const verifyPinSchema = z
  .object({
    pin: z.string().length(4).regex(/^\d{4}$/),
  })
  .openapi("VerifyPinBody");

export const refreshSchema = z
  .object({ refresh_token: z.string() })
  .openapi("RefreshTokenBody");

/** Optional body of POST /auth/google and /auth/apple (step 2: chosen role). */
export const socialSyncSchema = z
  .object({ role: z.string().optional() })
  .openapi("SocialSyncBody");

export const uploadAvatarSchema = z
  .object({
    image_base64: z.string().min(1),
    content_type: z.enum(["image/jpeg", "image/jpg", "image/png", "image/webp"]),
  })
  .openapi("UploadAvatarBody");

// ─── Response schemas ────────────────────────────────────────────────

/**
 * A `public.users` row as the API returns it — `pin_hash` is stripped by
 * `publicUser()` before any user row leaves the server.
 */
export const UserSchema = rowSchema(users, "UserRow").omit({ pin_hash: true }).openapi("User");

/** Strip secrets from a users row before returning it to a client. */
export function publicUser<T extends { pin_hash?: unknown } | null | undefined>(row: T) {
  if (!row) return row as Exclude<T, { pin_hash?: unknown }>;
  const { pin_hash: _omit, ...rest } = row as { pin_hash?: unknown } & Record<string, unknown>;
  return rest as Omit<NonNullable<T>, "pin_hash">;
}
export const RiderProfileSchema = rowSchema(riderProfiles, "RiderProfile");
export const VehicleSchema = rowSchema(vehicles, "Vehicle");
export const AgentShopSchema = rowSchema(agentShops, "AgentShop", {
  hours: weekHoursSchema.nullable(),
  documents: documentsSchema,
  review_status: z.enum(["under_review", "active", "rejected"]),
});

const reviewedDocSchema = z
  .object({
    url: z.string(),
    status: z.enum(["pending", "verified", "rejected"]),
    reason: z.string().nullable().optional(),
  })
  .openapi("AgentReviewedDocument");

/** An agent's business documents (agent_profiles.documents). */
export const AgentDocumentsSchema = z
  .object({
    commercial_register_front: reviewedDocSchema.optional(),
    commercial_register_back: reviewedDocSchema.optional(),
    nif: z.string().optional(),
    nis: z.string().optional(),
  })
  .openapi("AgentDocuments");

export const AgentProfileSchema = rowSchema(agentProfiles, "AgentProfile", {
  documents: AgentDocumentsSchema,
});
export const MerchantProfileSchema = rowSchema(merchantProfiles, "MerchantProfile");
export const CustomerProfileSchema = rowSchema(customerProfiles, "CustomerProfile");

export const MessageResponse = z
  .object({ message: z.string() })
  .openapi("AuthMessageResponse");

export const SessionTokensResponse = z
  .object({ access_token: z.string(), refresh_token: z.string() })
  .openapi("SessionTokens");

/** Stub returned for a brand-new OTP user (the row was just inserted). */
const OtpStubUser = z
  .object({ id: z.string(), phone_number: z.string() })
  .openapi("OtpStubUser");

export const VerifyOtpResponse = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    is_new_user: z.boolean(),
    user: z.union([UserSchema, OtpStubUser]),
  })
  .openapi("VerifyOtpResponse");

export const SocialSyncResponse = z
  .object({ is_new_user: z.boolean(), user: UserSchema.nullable() })
  .openapi("SocialSyncResponse");

export const SelectRoleResponse = z
  .object({ message: z.string(), role: selectRoleSchema.shape.role })
  .openapi("SelectRoleResponse");

export const AuthUserResponse = z.object({ user: UserSchema }).openapi("AuthUserResponse");

/** GET /auth/profile — `user` plus the role-specific rows for the user's role. */
export const AuthProfileResponse = z
  .object({
    user: UserSchema,
    rider_profile: RiderProfileSchema.nullable().optional(),
    vehicle: VehicleSchema.nullable().optional(),
    shop: AgentShopSchema.nullable().optional(),
    agent_profile: AgentProfileSchema.nullable().optional(),
    merchant_profile: MerchantProfileSchema.nullable().optional(),
    customer_profile: CustomerProfileSchema.nullable().optional(),
  })
  .openapi("AuthProfileResponse");

export const AvatarUploadResponse = z
  .object({ url: z.string() })
  .openapi("AvatarUploadResponse");

export const VerifyPinResponse = z
  .object({ valid: z.boolean() })
  .openapi("VerifyPinResponse");
