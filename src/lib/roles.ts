/**
 * Multi-role accounts — pure rules (no I/O; node-tested in roles.test.ts).
 *
 * One person, many roles: `users.granted_roles` lists every role unlocked on
 * the account and `users.role` is the ACTIVE one, which requireRole, RLS and
 * realtime keep reading. Every account always holds `customer`, and the active
 * role is always granted. The DB keeps the same invariant for every writer
 * (trigger in 20261010200000_users_granted_roles.sql).
 */

/** The app personas, in `user_role` enum order. */
export const APP_ROLES = ["customer", "rider", "merchant", "agent"] as const;
export type AppRole = (typeof APP_ROLES)[number];

/** Roles a signed-in account can unlock from Become a Partner. */
export const PARTNER_ROLES = ["rider", "merchant", "agent"] as const;
export type PartnerRole = (typeof PARTNER_ROLES)[number];

/** `code` of the 403 body when switching to a role the account doesn't hold. */
export const ROLE_NOT_GRANTED = "role_not_granted";

/** `code` of the 409 body when a rider with assigned work tries to leave rider. */
export const ACTIVE_JOB = "active_job";

/**
 * `order_status` values that end a job. Any other order assigned to a rider is
 * active work: in progress (heading_to_store → on_the_way) or booked (a
 * scheduled job stays `searching` with `rider_id` set). Rides and parcels are
 * `orders` rows too (order_type ride / courier).
 */
export const FINAL_ORDER_STATUSES = ["delivered", "canceled", "merchant_rejected"] as const;

function isAppRole(role: unknown): role is AppRole {
  return typeof role === "string" && (APP_ROLES as readonly string[]).includes(role);
}

/**
 * The canonical granted set: known roles only, deduplicated, always with
 * `customer` (and `active` when given), in enum order.
 */
export function normalizeGranted(
  granted: readonly string[] | null | undefined,
  active?: string | null,
): AppRole[] {
  const held = new Set<string>([...(granted ?? []), "customer"]);
  if (active) held.add(active);
  return APP_ROLES.filter((role) => held.has(role));
}

/** `granted_roles` of a brand-new account: the role chosen at sign-up, plus customer. */
export function initialGrantedRoles(chosen: AppRole): AppRole[] {
  return normalizeGranted([chosen]);
}

/** Unlock `role`. `added` is false when the account already held it (idempotent). */
export function grantRole(
  granted: readonly string[] | null | undefined,
  role: AppRole,
): { granted: AppRole[]; added: boolean } {
  const current = normalizeGranted(granted);
  if (current.includes(role)) return { granted: current, added: false };
  return { granted: normalizeGranted([...current, role]), added: true };
}

/** May the account make `role` its active role? */
export function canActivate(granted: readonly string[] | null | undefined, role: string): role is AppRole {
  return isAppRole(role) && normalizeGranted(granted).includes(role);
}

/** Switching away from rider: dispatch must stop offering this person jobs. */
export function leavesRider(from: string | null | undefined, to: string): boolean {
  return from === "rider" && to !== "rider";
}

/**
 * May the account switch from `from` to `to`? Nobody stops being a rider
 * mid-delivery: leaving rider needs zero assigned jobs (in progress or booked).
 * Leaving merchant / agent / customer is never blocked.
 */
export function canLeaveRole(
  from: string | null | undefined,
  to: string,
  work: { activeJobCount: number },
): boolean {
  return !leavesRider(from, to) || work.activeJobCount === 0;
}

/**
 * A sign-up / social sync that names a role conflicts only when the existing
 * account doesn't hold it. `customer` never conflicts: every account holds it.
 */
export function signUpConflict(
  existing: { role: string; granted_roles?: readonly string[] | null },
  chosen: string,
): boolean {
  return !canActivate(normalizeGranted(existing.granted_roles, existing.role), chosen);
}

/** 409 copy for a sign-up that names a role the account doesn't hold. */
export function roleConflictMessage(existingRole: string, chosen: string): string {
  return `This account already exists as ${existingRole}. Sign in, then add ${chosen} from Profile → Become a Partner.`;
}
