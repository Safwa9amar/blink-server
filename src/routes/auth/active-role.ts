import { releaseRiderRequests } from "../../lib/dispatch";
import {
  ACTIVE_JOB,
  canActivate,
  canLeaveRole,
  FINAL_ORDER_STATUSES,
  leavesRider,
  normalizeGranted,
  ROLE_NOT_GRANTED,
} from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import type { UserRow } from "../../types/database";
import { activeRoleSchema, AuthProfileResponse } from "../../validators/auth";
import { authProfilePayload } from "./profile-payload";
import { ensureRoleProfile } from "./shared";

const app = router();

// ─── Switch the active role ──────────────────────────────────────────
// Sets users.role to a role the account already holds (granted_roles). Every
// requireRole / RLS / realtime check reads users.role, so this is the whole
// switch; the last switch wins across devices. Nobody stops being a rider
// mid-delivery: leaving rider is refused (409 active_job) while any order is
// assigned to them unfinished, in progress or booked. Otherwise leaving rider
// takes the rider offline (rider_profiles.is_available = false) and frees any
// store request held for them, so dispatch stops offering jobs; switching back
// keeps them offline until they go online. Leaving merchant or agent changes
// nothing else: stores and shops keep their own open/closed state.

/**
 * Orders assigned to this rider that aren't finished: in progress or booked.
 * Rides and parcels are orders too; trips only mirror accepted orders, so
 * they aren't counted. Null when the count couldn't be read.
 */
async function activeRiderJobCount(riderId: string): Promise<number | null> {
  const { count, error } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("rider_id", riderId)
    .not("status", "in", `(${FINAL_ORDER_STATUSES.join(",")})`);
  return error ? null : count ?? 0;
}

const route = createRoute({
  method: "post",
  path: "/active-role",
  operationId: "setActiveRole",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(activeRoleSchema), required: true } },
  responses: {
    200: json(AuthProfileResponse),
    400: errorResponses[400],
    401: errorResponses[401],
    403: json(ErrorSchema, "The account doesn't hold this role (body code: role_not_granted)"),
    404: errorResponses[404],
    409: json(ErrorSchema, "Leaving rider with a job in progress or booked (body code: active_job)"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const { role } = c.req.valid("json");

  if (!canActivate(normalizeGranted(user.granted_roles, user.role), role)) {
    return c.json(
      {
        error: "This role isn't unlocked on your account. Add it from Profile → Become a Partner.",
        code: ROLE_NOT_GRANTED,
      },
      403,
    );
  }
  if (role === user.role) return c.json(await authProfilePayload(user), 200);

  const leaving = leavesRider(user.role, role);

  // Checked before anything is written: a refused switch leaves the rider
  // exactly as they were (online, requests held).
  if (leaving) {
    const activeJobCount = await activeRiderJobCount(user.id);
    if (activeJobCount === null) {
      return c.json({ error: "Couldn't check your current jobs, please retry" }, 400);
    }
    if (!canLeaveRole(user.role, role, { activeJobCount })) {
      return c.json(
        {
          error: "Finish your job in progress (or cancel your booked jobs) before switching role.",
          code: ACTIVE_JOB,
        },
        409,
      );
    }
  }

  // Offline BEFORE the switch: if the role write then fails, the person is just
  // an offline rider — never a customer who still receives jobs.
  if (leaving) {
    const { error: offlineError } = await supabaseAdmin
      .from("rider_profiles")
      .update({ is_available: false })
      .eq("user_id", user.id);
    if (offlineError) return c.json({ error: offlineError.message }, 400);
    await releaseRiderRequests(user.id);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .update({ role })
    .eq("id", user.id)
    .select("*")
    .single();
  if (error || !data) {
    return c.json({ error: error?.message ?? "User profile not found" }, 400);
  }

  // Accounts from before multi-role may lack the profile row of a role they
  // hold implicitly (customer): create it on first use. Idempotent.
  await ensureRoleProfile(user.id, role);

  return c.json(await authProfilePayload(data as UserRow), 200);
});

export default app;
