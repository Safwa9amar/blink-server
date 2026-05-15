import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env";

// Untyped clients — run `npm run db:types` after `supabase start` to generate proper types
// Then import Database from "../types/supabase" and add it as generic: createClient<Database>(...)

// Client with anon key — respects RLS
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY
);

// Admin client — bypasses RLS (use only in server-side trusted operations)
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY
);
