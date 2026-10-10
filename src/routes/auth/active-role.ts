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
// mid-delivery. Order of work, safety writes first so a failure leaves the
// role unchanged and a retry can finish:
//   leaving rider:  active-job check (409 active_job) -> rider offline ->
//                   release held store requests
//   entering rider: create the rider row offline / force it offline
//   then ensureRoleProfile, then the users.role write.
// Leaving rider re-counts jobs after the role write (an accept that passed
// requireRole("rider") before the switch can still claim an order in between)
// and rolls the role back to rider with 409 if one landed. The rider stays
// offline either way. Leaving merchant or agent changes nothing else.

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

  // rider_profiles.is_available now defaults to false, but dispatch offers jobs on
  // that flag alone: someone entering rider must start offline.
  if (role === "rider" && user.role !== "rider") {
    const { error: createError } = await supabaseAdmin
      .from("rider_profiles")
      .upsert(
        { user_id: user.id, is_available: false },
        { onConflict: "user_id", ignoreDuplicates: true },
      );
    if (createError) return c.json({ error: createError.message }, 400);
    const { error: offlineError } = await supabaseAdmin
      .from("rider_profiles")
      .update({ is_available: false })
      .eq("user_id", user.id);
    if (offlineError) return c.json({ error: offlineError.message }, 400);
  }

  // Before the role write: a failure leaves the role unchanged and a retry
  // repairs it. Idempotent.
  await ensureRoleProfile(user.id, role);

  const { data, error } = await supabaseAdmin
    .from("users")
    .update({ role })
    .eq("id", user.id)
    .select("*")
    .single();
  if (error || !data) {
    return c.json({ error: error?.message ?? "User profile not found" }, 400);
  }

  // An accept that passed requireRole("rider") before the switch may have
  // claimed an order since the first count: re-check and roll back.
  if (leaving) {
    const recount = await activeRiderJobCount(user.id);
    if (recount === null || recount > 0) {
      const { error: rollbackError } = await supabaseAdmin
        .from("users")
        .update({ role: "rider" })
        .eq("id", user.id);
      if (rollbackError) {
        return c.json(
          { error: `Couldn't confirm your jobs and couldn't undo the switch: ${rollbackError.message}` },
          400,
        );
      }
      if (recount === null) {
        return c.json({ error: "Couldn't check your current jobs, please retry" }, 400);
      }
      return c.json(
        {
          error: "Finish your job in progress (or cancel your booked jobs) before switching role.",
          code: ACTIVE_JOB,
        },
        409,
      );
    }
  }

  return c.json(await authProfilePayload(data as UserRow), 200);
});

export default app;
