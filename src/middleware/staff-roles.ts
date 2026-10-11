import { createMiddleware } from "hono/factory";
import type { UserRow } from "../types/database";
import type { AuthEnv } from "./auth";

export type StaffRole = NonNullable<UserRow["staff_role"]>;

/** `code` of the 403 body when the caller's staff role isn't allowed. */
export const STAFF_ROLE_REQUIRED = "staff_role_required";

/**
 * Staff guard scoped to console roles (users.staff_role) — the server-side
 * mirror of the dashboard's ROLE_ACCESS (blink-dashboard src/lib/auth/access.ts).
 * `super_admin` is always allowed. Like requireStaff, there is no dev fallback.
 */
export function requireStaffRole(...roles: StaffRole[]) {
  const allowed = [...new Set<StaffRole>(["super_admin", ...roles])];
  return createMiddleware<AuthEnv>(async (c, next) => {
    const staff = c.get("user").staff_role;
    if (!staff || !allowed.includes(staff)) {
      return c.json(
        { error: `Access denied. Required staff role: ${allowed.join(" | ")}`, code: STAFF_ROLE_REQUIRED },
        403
      );
    }
    await next();
  });
}
