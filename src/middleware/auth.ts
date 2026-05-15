import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
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

  const {
    data: { user: supaUser },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !supaUser) {
    return c.json({ error: "Invalid or expired token" }, 401);
  }

  // Fetch app user profile
  const { data: appUser, error: profileError } = await supabaseAdmin
    .from("users")
    .select("*")
    .eq("id", supaUser.id)
    .single();

  if (profileError || !appUser) {
    return c.json({ error: "User profile not found" }, 404);
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
