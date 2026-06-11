import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, requireRole, type AuthEnv } from "../../middleware/auth";

const app = new Hono<AuthEnv>();

// ─── Agent: get own personal profile (display ID) ────────────────────
// agent_profiles holds only the auto-generated agent_id — there's nothing to
// PATCH (editable fields live on users via /auth/profile). Create-if-missing so
// agents created before this table existed still get a display ID.
app.get("/profile", auth, requireRole("agent"), async (c) => {
  const user = c.get("user");

  const { data: existing } = await supabaseAdmin
    .from("agent_profiles")
    .select("*")
    .eq("user_id", user.id)
    .single();

  if (existing) {
    return c.json({ profile: existing });
  }

  const { data: created, error } = await supabaseAdmin
    .from("agent_profiles")
    .insert({ user_id: user.id })
    .select()
    .single();

  if (error || !created) {
    return c.json(
      { error: error?.message ?? "Could not create agent profile" },
      400,
    );
  }

  return c.json({ profile: created });
});

export default app;
