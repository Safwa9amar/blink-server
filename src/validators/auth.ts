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
import { RIDER_VERIFICATION_STATUSES } from "../lib/rider-verification";
import { rowSchema } from "../openapi";
import { documentsSchema, weekHoursSchema } from "./merchant";
import { APP_ROLES, PARTNER_ROLES } from "../lib/roles";

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

/** POST /auth/partner-roles — a role a signed-in account unlocks (Become a Partner). */
export const partnerRoleSchema = z
  .object({ role: z.enum(PARTNER_ROLES) })
  .openapi("PartnerRoleBody");

/** POST /auth/active-role — the role to make active (must already be granted). */
export const activeRoleSchema = z
  .object({ role: z.enum(APP_ROLES) })
  .openapi("ActiveRoleBody");

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

export const changePinSchema = z
  .object({
    current_pin: z.string().length(4).regex(/^\d{4}$/),
    new_pin: z.string().length(4, "PIN must be 4 digits").regex(/^\d{4}$/),
  })
  .openapi("ChangePinBody");

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

/** Finish a phone sign-up: the details form + the chosen role, in one call. */
export const registerPhoneSchema = z
  .object({
    role: selectRoleSchema.shape.role,
    first_name: z.string().trim().min(1).max(50),
    last_name: z.string().trim().min(1).max(50),
    middle_name: z.string().trim().max(50).optional(),
    email: z.string().trim().email().optional(),
  })
  .openapi("RegisterPhoneBody");

/** POST /auth/phone/link — the access token from POST /auth/otp/verify, as proof of the number. */
export const linkPhoneSchema = z
  .object({ phone_token: z.string().min(1) })
  .openapi("LinkPhoneBody");

/** GET /auth/email-available — the address typed on the sign-up details form. */
export const emailAvailableQuerySchema = z.object({
  email: z.string().trim().email().openapi({ description: "Email to check" }),
});

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
export const UserSchema = rowSchema(users, "UserRow", {
  // Every role unlocked on the account; `role` is the active one.
  granted_roles: z.array(z.enum(APP_ROLES)),
})
  .omit({ pin_hash: true, pin_failed_attempts: true, pin_locked_until: true })
  .openapi("User");
/** Named nullable wrapper: reusing a bare `UserSchema.nullable()` makes the
 *  OpenAPI generator mark the `User` component itself nullable app-wide. */
const NullableUser = UserSchema.nullable().openapi("NullableUser");

/** Strip secrets (PIN hash + lockout state) from a users row before returning it to a client. */
export function publicUser<T extends { pin_hash?: unknown } | null | undefined>(row: T) {
  if (!row) return row as Exclude<T, { pin_hash?: unknown }>;
  const {
    pin_hash: _omit,
    pin_failed_attempts: _attempts,
    pin_locked_until: _locked,
    ...rest
  } = row as { pin_hash?: unknown } & Record<string, unknown>;
  return rest as Omit<NonNullable<T>, "pin_hash" | "pin_failed_attempts" | "pin_locked_until">;
}
const riderStoredDocSchema = z
  .object({
    path: z.string(),
    status: z.enum(["pending", "verified", "rejected"]),
    note: z.string().nullable(),
    uploaded_at: z.string(),
    reviewed_by: z.string().nullable().optional(),
    reviewed_at: z.string().nullable().optional(),
  })
  .openapi("RiderStoredDocument");

/** rider_profiles.documents — licence + national ID scans (private bucket paths). */
export const RiderStoredDocumentsSchema = z
  .object({
    license_front: riderStoredDocSchema.optional(),
    license_back: riderStoredDocSchema.optional(),
    id_front: riderStoredDocSchema.optional(),
    id_back: riderStoredDocSchema.optional(),
  })
  .openapi("RiderStoredDocuments");

export const RiderVerificationStatusSchema = z
  .enum(RIDER_VERIFICATION_STATUSES)
  .openapi("RiderVerificationStatus");

export const RiderProfileSchema = rowSchema(riderProfiles, "RiderProfile", {
  documents: RiderStoredDocumentsSchema,
  verification_status: RiderVerificationStatusSchema,
});
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

export const EmailAvailableResponse = z
  .object({ available: z.boolean() })
  .openapi("EmailAvailableResponse");

export const SessionTokensResponse = z
  .object({ access_token: z.string(), refresh_token: z.string() })
  .openapi("SessionTokens");

/** `user` is null for a brand-new phone user: like OAuth, the profile row is
 *  only created once they pick a role (POST /auth/otp/register). */
export const VerifyOtpResponse = z
  .object({
    access_token: z.string(),
    refresh_token: z.string(),
    is_new_user: z.boolean(),
    user: NullableUser,
    // Set when the number is saved, unverified, on an account that signs in
    // another way ("google", "apple", …). Then the tokens are only proof of the
    // number: sign in with that provider and send the access token to
    // POST /auth/phone/link, after which OTP logins open that account directly.
    link_provider: z.string().nullable(),
  })
  .openapi("VerifyOtpResponse");

export const SocialSyncResponse = z
  .object({ is_new_user: z.boolean(), user: NullableUser })
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
    /** Set whenever the user has a rider profile, whatever the active role —
     *  the Become a Partner rider card shows it. Null: rider never unlocked. */
    rider_verification_status: RiderVerificationStatusSchema.nullable().optional(),
  })
  .openapi("AuthProfileResponse");

export const AvatarUploadResponse = z
  .object({ url: z.string() })
  .openapi("AvatarUploadResponse");

export const VerifyPinResponse = z
  .object({ valid: z.boolean() })
  .openapi("VerifyPinResponse");
