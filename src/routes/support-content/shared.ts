// Shared helpers for the Help Center reader endpoints.

// The app user_role enum is lowercase ("rider"); support `target_roles` use the
// dashboard's capitalized labels ("Rider"). Map one to the other for targeting.
export const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  rider: "Rider",
  merchant: "Merchant",
  agent: "Agent",
};

// Audience for the current user: "All" plus their own role label.
export function audienceFor(role: string): string[] {
  const label = ROLE_LABEL[role];
  return label ? ["All", label] : ["All"];
}
