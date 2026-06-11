import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Refresh Token ───────────────────────────────────────────────────
app.post("/refresh", async (c) => {
  const { refresh_token } = await c.req.json();

  if (!refresh_token) {
    return c.json({ error: "refresh_token is required" }, 400);
  }

  const { data, error } = await supabaseAdmin.auth.refreshSession({
    refresh_token,
  });

  if (error || !data.session) {
    return c.json({ error: error?.message ?? "Could not refresh session" }, 401);
  }

  return c.json({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
});

export default app;
