import { Hono } from "hono";
import { supabaseAdmin } from "../../lib/supabase";
import type { AuthEnv } from "../../middleware/auth";
import { VALID_ROLES, ensureRoleProfile, type ServerRole } from "./shared";

const app = new Hono<AuthEnv>();

// ─── Apple OAuth sync ────────────────────────────────────────────────
// Standalone counterpart to POST /google (each social provider is its own
// feature). Same two-step contract — verify the Supabase JWT, return the
// existing profile or create one once a role is chosen — but parses Apple's
// name metadata (`full_name`/`name`), which it only sends on first sign-in.
app.post("/apple", async (c) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  const token = header.slice(7);

  const {
    data: { user: supaUser },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !supaUser) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  const { data: existingUser } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", supaUser.id)
    .single();

  // Parse the optional chosen role (used by both branches below).
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const role = body.role as string | undefined;

  // Existing user.
  if (existingUser) {
    // Option A: an account is ONE role. Reject re-registering the same Apple ID
    // under a different role (the bug where it silently returned the old role).
    if (role && role !== existingUser.role) {
      return c.json(
        {
          error: `This account already exists as ${existingUser.role}. Sign in as ${existingUser.role}, or use a different account to register as ${role}.`,
        },
        409,
      );
    }
    // Backfill the role profile if missing, then return the existing profile.
    await ensureRoleProfile(existingUser.id, existingUser.role as ServerRole);
    return c.json({ is_new_user: false, user: existingUser });
  }

  // Step 1: no role yet — report new, create nothing.
  if (!role) {
    return c.json({ is_new_user: true, user: null });
  }

  // Step 2: create the profile with the chosen role.
  if (!VALID_ROLES.includes(role as ServerRole)) {
    return c.json({ error: `Invalid role: ${role}` }, 400);
  }

  // Apple sends the display name as `full_name`/`name` (only on first auth),
  // not split fields — fall back to splitting it on the first space.
  const meta = supaUser.user_metadata ?? {};
  const fullName = (meta.full_name ?? meta.name) as string | undefined;
  const [firstFromFull, ...restFromFull] = (fullName ?? "").trim().split(/\s+/);
  const firstName = (meta.given_name as string) ?? (firstFromFull || null);
  const lastName =
    (meta.family_name as string) ?? (restFromFull.join(" ") || null);

  const { data: created, error: insertError } = await supabaseAdmin
    .from("users")
    .insert({
      id: supaUser.id,
      email: supaUser.email ?? null,
      first_name: firstName,
      last_name: lastName,
      role: role as ServerRole,
    })
    .select("*")
    .single();

  if (insertError) {
    return c.json({ error: insertError.message }, 400);
  }

  // Create the role-specific profile row(s) for the chosen role (mirrors POST
  // /google and /auth/role). All four roles handled.
  await ensureRoleProfile(supaUser.id, role as ServerRole);

  return c.json({ is_new_user: true, user: created });
});

export default app;
