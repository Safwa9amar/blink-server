import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import { auth, type AuthEnv } from "../../middleware/auth";
import { selectRoleSchema } from "../../validators/auth";
import { ensureRoleProfile } from "./shared";

const app = new Hono<AuthEnv>();

// ─── Select Role (post-registration) ────────────────────────────────
app.post("/role", auth, async (c) => {
  const body = selectRoleSchema.parse(await c.req.json());
  const userId = c.get("userId");

  const { error } = await supabaseAdmin
    .from("users")
    .update({ role: body.role })
    .eq("id", userId);

  if (error) {
    return c.json({ error: error.message }, 400);
  }

  // Create the role-specific profile row(s) for the chosen role. All four roles
  // are handled here (see ensureRoleProfile) — previously only rider/agent were.
  await ensureRoleProfile(userId, body.role);

  return c.json({ message: "Role updated", role: body.role });
});

export default app;
