import { timestamp } from "drizzle-orm/pg-core";

// Timestamps shared by every table. `mode: "string"` makes the inferred type
// an ISO string — matching what @supabase/supabase-js / PostgREST return at
// runtime (both apps query via supabase-js, not the Drizzle client).
// The `updated_at` auto-bump is a Postgres trigger (update_updated_at), added
// in the baseline migration — Drizzle can't model triggers in the schema.
export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .notNull()
    .defaultNow(),
};
