// Shared helpers/constants for the news feed endpoints.

// The app user_role enum is lowercase ("rider"); news `target_roles` use the
// dashboard's capitalized labels ("Rider"). Map one to the other for targeting.
export const ROLE_LABEL: Record<string, string> = {
  customer: "Customer",
  rider: "Rider",
  merchant: "Merchant",
  agent: "Agent",
};

// Columns the app needs — omits admin-only analytics like `clicks` and `author_id`.
export const FEED_COLUMNS =
  "id, slug, category, cover_url, target_roles, status, pinned, push, cta_label, content_eng, content_fr, content_ar, views, published_at, expires_at, created_at";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Audience for the current user: "All" plus their own role label.
export function audienceFor(role: string): string[] {
  const label = ROLE_LABEL[role];
  return label ? ["All", label] : ["All"];
}
