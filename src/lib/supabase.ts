import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "../config/env";

const options = {
  realtime: { transport: ws },
};

// Client with anon key — respects RLS
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_ANON_KEY,
  options
);

// Admin client — bypasses RLS (use only in server-side trusted operations)
export const supabaseAdmin = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  options
);
