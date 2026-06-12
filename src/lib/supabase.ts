import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import { env } from "../config/env";

const options = {
  // `ws`'s constructor type doesn't line up with supabase-js's
  // WebSocketLikeConstructor (its `address` param is typed `null`). The runtime
  // behaviour is correct — cast to satisfy tsc. Known baseline mismatch.
  realtime: { transport: ws as unknown as never },
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
