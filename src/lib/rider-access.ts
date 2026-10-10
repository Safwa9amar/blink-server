// Can this rider do rider work (go online, see offers, accept jobs, count as a
// nearby rider)? Only once staff approved their documents. Existing riders
// were migrated as approved (20261010232027_rider_verification.sql).

export function riderCanWork(
  profile: { verification_status?: string | null } | null | undefined
): boolean {
  return profile?.verification_status === "approved";
}

/** 403 body (RiderNotVerifiedError) — the app maps `code` to a translated message. */
export const RIDER_NOT_VERIFIED = {
  error: "Your rider account isn't verified yet. Upload your documents in Profile → Documents.",
  code: "rider_not_verified" as const,
};
