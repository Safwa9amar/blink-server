// "A partner account Blink hasn't verified can browse (GET) but can't operate."
// Verified means:
//   rider    rider_profiles.verification_status = 'approved'
//   agent    at least one agent_shops row with review_status = 'active'
//            (the value staff's approval writes — src/routes/agents/admin-review.ts)
//   merchant at least one stores row (owner_id = user) with status = 'active'
// The matcher below is pure (unit-tested in verified-account.test.ts); the
// DB check and the middleware wrapper live next to it.
import { createMiddleware } from "hono/factory";
import { env } from "../config/env";
import type { AuthEnv } from "../middleware/auth";
import { supabaseAdmin } from "./supabase";

export type PartnerRole = "rider" | "agent" | "merchant";
export const PARTNER_ROLES: readonly PartnerRole[] = ["rider", "agent", "merchant"];

/** 403 body — the mobile app maps `code` to its translated "wait for Blink" message. */
export const accountNotVerified = (role: PartnerRole) => ({
  error: "Your account must be verified by Blink first",
  code: "account_not_verified" as const,
  role,
});

/** An onboarding route that stays open while unverified. `{x}` matches one path segment. */
export interface AllowedRoute {
  method: string;
  path: string;
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

const patternToRegExp = (pattern: string) =>
  new RegExp(
    "^" +
      trimSlash(pattern)
        .split("/")
        .map((seg) => (/^\{[^}]+\}$/.test(seg) ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
        .join("/") +
      "$"
  );

/**
 * Does this request need a verified account? Reads never do; a write does
 * unless it matches the onboarding allowlist. `path` is relative to the group
 * (e.g. "/vehicle", not "/riders/vehicle").
 */
export function needsVerification(method: string, path: string, allowlist: readonly AllowedRoute[]): boolean {
  const m = method.toUpperCase();
  if (READ_METHODS.has(m)) return false;
  const p = trimSlash(path);
  return !allowlist.some((r) => r.method.toUpperCase() === m && patternToRegExp(r.path).test(p));
}

/** Throws on a DB error (the caller fails closed with 503). */
export async function isAccountVerified(userId: string, role: PartnerRole): Promise<boolean> {
  const query =
    role === "rider"
      ? supabaseAdmin
          .from("rider_profiles")
          .select("user_id")
          .eq("user_id", userId)
          .eq("verification_status", "approved")
      : role === "agent"
        ? supabaseAdmin.from("agent_shops").select("id").eq("user_id", userId).eq("review_status", "active")
        : supabaseAdmin.from("stores").select("id").eq("owner_id", userId).eq("status", "active");
  const { data, error } = await query.limit(1);
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

/**
 * Middleware (mount AFTER auth). Applies to the user's active partner role
 * only — customers and staff-only sessions pass untouched. `prefix` is the
 * group's mount ("/riders"); omit it for groups outside the partner apps
 * (orders, trips, transactions), where every write counts as an operation.
 */
export function requireVerifiedPartner(opts: { prefix?: string; allow?: readonly AllowedRoute[]; skip?: string } = {}) {
  const { prefix = "", allow = [], skip } = opts;
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user");
    const role = user.role as string;
    if (!(PARTNER_ROLES as readonly string[]).includes(role)) return next();

    const full = c.req.path;
    const base = `${env.BASE_PATH}${prefix}`;
    const rel = full.startsWith(base) ? full.slice(base.length) || "/" : full;
    if (skip && rel.startsWith(skip)) return next(); // staff sub-routes
    if (!needsVerification(c.req.method, rel, allow)) return next();

    try {
      if (await isAccountVerified(user.id, role as PartnerRole)) return next();
    } catch {
      return c.json({ error: "Service unavailable, please retry" }, 503);
    }
    return c.json(accountNotVerified(role as PartnerRole), 403);
  });
}

// ─── Onboarding allowlists (writes that stay open while unverified) ──
export const RIDER_ONBOARDING: readonly AllowedRoute[] = [
  { method: "PATCH", path: "/profile" },
  { method: "PUT", path: "/vehicle" },
  { method: "POST", path: "/uploads" },
  { method: "PATCH", path: "/documents" },
  // Their own gates already refuse going online; going OFFLINE must always work.
  { method: "PATCH", path: "/availability" },
  { method: "PATCH", path: "/location" },
];

export const AGENT_ONBOARDING: readonly AllowedRoute[] = [
  { method: "PATCH", path: "/profile" },
  { method: "PATCH", path: "/shop" },
  { method: "POST", path: "/shops" },
  { method: "PATCH", path: "/shops/{id}" },
  { method: "POST", path: "/uploads" },
];

export const MERCHANT_ONBOARDING: readonly AllowedRoute[] = [
  { method: "POST", path: "/stores" },
  { method: "PATCH", path: "/stores/{id}" },
  { method: "POST", path: "/stores/{id}/resubmit" },
  { method: "POST", path: "/uploads" },
  { method: "POST", path: "/stores/{id}/products" },
  { method: "PATCH", path: "/products/{id}" },
  { method: "DELETE", path: "/products/{id}" },
  { method: "POST", path: "/stores/{id}/packs" },
  { method: "PATCH", path: "/packs/{id}" },
  { method: "DELETE", path: "/packs/{id}" },
  { method: "POST", path: "/stores/{id}/categories" },
];
