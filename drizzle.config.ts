import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Drizzle is the source of truth for the Blink DB schema (src/db/schema).
// `npm run db:generate` diffs the TS schema against ./drizzle/meta and emits SQL
// — no DB connection needed. The generated SQL is applied through the existing
// Supabase pipeline (see supabase/migrations + `npm run db:push`); `drizzle-kit
// migrate|push|pull|studio` connect with DATABASE_URL when you want them.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Don't manage Supabase's built-in roles — only reference them in RLS policies.
  entities: {
    roles: {
      provider: "supabase",
    },
  },
  casing: "snake_case",
  verbose: true,
  strict: true,
});
