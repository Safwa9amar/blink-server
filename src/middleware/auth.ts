import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { env } from "../config/env";
import { isAuthOutage } from "../lib/auth-outage";
import { rejectedTokenMessage } from "../lib/token-issuer";
import { supabaseAdmin } from "../lib/supabase";
import type { UserRole, UserRow } from "../types/database";

export type AuthEnv = {
  Variables: {
    user: UserRow;
    userId: string;
  };
};

// Verify Supabase JWT and attach user to context
export const auth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }

  const token = header.slice(7);
  let result = await supabaseAdmin.auth.getUser(token);
  // One retry: a network blip reaching Supabase Auth is common in dev.
  if (isAuthOutage(result.error)) result = await supabaseAdmin.auth.getUser(token);
  const {
    data: { user: supaUser },
    error,
  } = result;

  // 503, not 401: the app signs the user out on a 401 (expired session).
  if (isAuthOutage(error)) {
    return c.json({ error: "Authentication service unavailable, please retry" }, 503);
  }
  if (error || !supaUser) {
    return c.json({ error: rejectedTokenMessage(token, env.SUPABASE_URL) }, 401);
  }

  // Fetch app user profile
  const { data: appUser, error: profileError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", supaUser.id)
    .single();

  if (!appUser) {
    // No row (PGRST116) is a real 404; anything else is the database
    // being unreachable for a moment.
    return profileError && profileError.code !== "PGRST116"
      ? c.json({ error: "Service temporarily unavailable, please retry" }, 503)
      : c.json({ error: "User profile not found" }, 404);
  }

  c.set("user", appUser as UserRow);
  c.set("userId", supaUser.id);
  await next();
});

// Role guard — restrict access to specific roles
export function requireRole(...roles: UserRole[]) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user");
    if (!roles.includes(user.role)) {
      return c.json(
        { error: `Access denied. Required role: ${roles.join(" | ")}` },
        403
      );
    }
    await next();
  });
}

// Staff guard — restrict to console/ERP operators (non-null staff_role).
// Unlike the dashboard, the server has NO dev fallback: the user's
// users.staff_role must actually be set (see migration 00021).
export function requireStaff() {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user");
    const staff = user.staff_role;
    if (!staff) {
      return c.json({ error: "Access denied. Staff only." }, 403);
    }
    await next();
  });
}
