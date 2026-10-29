import { sql } from "drizzle-orm";
import { pgPolicy, timestamp } from "drizzle-orm/pg-core";

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

// Two-factor at the database level for staff-only tables reachable with a staff JWT:
// a RESTRICTIVE policy (ANDed with the permissive ones) that requires an aal2 session
// whenever the caller has a verified MFA factor. Tables app users also read (support
// chats) put `mfa_satisfied()` on their staff branch instead. `mfa_satisfied()` is defined in 20261030130000_staff_mfa_rls.sql.
export const mfaPolicy = (name: string) =>
  pgPolicy(name, {
    as: "restrictive",
    for: "all",
    to: "authenticated",
    using: sql`(select public.mfa_satisfied())`,
    withCheck: sql`(select public.mfa_satisfied())`,
  });
