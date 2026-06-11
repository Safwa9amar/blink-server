// Shared helpers/constants for the auth endpoints.

// Roles a brand-new OAuth user may choose when their profile row is created.
export const VALID_ROLES = ["customer", "rider", "merchant", "agent"] as const;
export type ServerRole = (typeof VALID_ROLES)[number];
