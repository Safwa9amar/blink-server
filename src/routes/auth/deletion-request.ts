import { z } from "@hono/zod-openapi";
import { computeAgentDues } from "../../lib/agent-finance";
import { bookedJobRows, currentJobRow, releaseRiderRequests } from "../../lib/dispatch";
import { APP_ROLES, deletionScope, rolesToClear, type AppRole } from "../../lib/roles";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router, rowSchema } from "../../openapi";
import { accountDeletionRequests } from "../../db/schema";
import { computeDues } from "../merchant/dues-shared";
import { ACTIVE_ORDER_STATUSES, ownedStores } from "../merchant/shared";

const app = router();

const deletionRequestSchema = z
  .object({
    reason: z.string().max(100).optional(),
    feedback: z.string().max(1000).optional(),
  })
  .openapi("AccountDeletionRequestBody");

const AccountDeletionRequestSchema = rowSchema(accountDeletionRequests, "AccountDeletionRequest", {
  status: z.enum(["pending", "completed", "cancelled"]),
  // `account`: the whole account goes. `role`: only `role` is removed, the
  // account keeps its other roles (staff complete both).
  scope: z.enum(["account", "role"]),
  user_snapshot: z
    .object({ name: z.string().nullable(), phone_number: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
});

/**
 * 409 — something in flight would be stranded: `dues` (agent/merchant owes
 * Blink), `active_jobs` (rider holds a delivery in progress or a booked job),
 * `open_orders` (merchant's stores or the customer's own orders not done yet).
 * `role` is the role it belongs to: deleting the whole account checks every
 * role the account holds, not just the active one.
 */
const AccountDeletionBlockedSchema = z
  .object({
    error: z.string(),
    code: z.enum(["dues", "active_jobs", "open_orders"]),
    role: z.enum(APP_ROLES),
  })
  .openapi("AccountDeletionBlocked");
type BlockCode = z.infer<typeof AccountDeletionBlockedSchema>["code"];

const BLOCK_MESSAGES: Record<BlockCode, string> = {
  dues: "Settle your outstanding dues before deleting your account",
  active_jobs: "Finish or cancel your jobs before deleting your account",
  open_orders: "Wait for your open orders to finish before deleting your account",
};

/** Why this user can't leave `role` yet, if anything. */
async function blockReason(userId: string, role: AppRole): Promise<BlockCode | null> {
  if (role === "agent") {
    const dues = await computeAgentDues(userId);
    return dues.total_dues > 0 ? "dues" : null;
  }
  if (role === "rider") {
    const [current, booked] = await Promise.all([currentJobRow(userId), bookedJobRows(userId)]);
    return current || booked.length ? "active_jobs" : null;
  }
  if (role === "merchant") {
    const [dues, stores] = await Promise.all([computeDues(userId), ownedStores(userId)]);
    if (dues.total_dues > 0) return "dues";
    if (!stores.length) return null;
    const { count } = await supabaseAdmin
      .from("orders")
      .select("id", { count: "exact", head: true })
      .in("store_id", stores.map((s) => s.id))
      .in("status", [...ACTIVE_ORDER_STATUSES]);
    return count ? "open_orders" : null;
  }
  // Customer: their own orders (incl. courier/ride requests) still in flight.
  if (role !== "customer") return null;
  const { count } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", userId)
    .in("status", [...ACTIVE_ORDER_STATUSES]);
  return count ? "open_orders" : null;
}

/** The first role among `roles` that can't be left yet, and why. */
async function firstBlock(userId: string, roles: AppRole[]) {
  for (const role of roles) {
    const code = await blockReason(userId, role);
    if (code) return { code, role };
  }
  return null;
}

/** What leaving `role` stops right away, before staff process the request. */
async function stepAway(userId: string, role: AppRole) {
  // Riders stop seeing an agent who is leaving.
  if (role === "agent") {
    await supabaseAdmin.from("agent_shops").update({ status: "closed" }).eq("user_id", userId);
  }
  // A leaving rider goes offline: no new offers, held ones go to someone else.
  if (role === "rider") {
    await supabaseAdmin.from("rider_profiles").update({ is_available: false }).eq("user_id", userId);
    await releaseRiderRequests(userId);
  }
  // Customers stop seeing a leaving merchant's stores.
  if (role === "merchant") {
    await supabaseAdmin.from("stores").update({ status: "inactive" }).eq("owner_id", userId).eq("status", "active");
  }
}

// ─── Request account deletion ────────────────────────────────────────
// Files (or refreshes) the user's pending request for their active role;
// staff complete it. In a partner role of a multi-role account it removes only
// that role (scope `role`); otherwise the whole account (scope `account`) —
// see deletionScope. Refused (409) while it would leave something stranded in
// any role it clears — see blockReason.
const route = createRoute({
  method: "post",
  path: "/account/deletion-request",
  operationId: "requestAccountDeletion",
  tags: ["auth"],
  security: bearer,
  middleware: [auth] as const,
  request: { body: { ...json(deletionRequestSchema), required: true } },
  responses: {
    201: json(z.object({ request: AccountDeletionRequestSchema }).openapi("AccountDeletionRequestResponse"), "Created"),
    400: errorResponses[400],
    401: errorResponses[401],
    409: json(AccountDeletionBlockedSchema, "Outstanding dues, jobs or orders"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");
  const role = user.role as AppRole;
  const scope = deletionScope(role, user.signup_role, user.granted_roles);
  const clearing = rolesToClear(scope, role, user.granted_roles);

  const blocked = await firstBlock(user.id, clearing);
  if (blocked) return c.json({ error: BLOCK_MESSAGES[blocked.code], ...blocked }, 409);

  const fields = { reason: body.reason ?? null, feedback: body.feedback ?? null, scope };
  const { data: pending } = await supabaseAdmin
    .from("account_deletion_requests")
    .select("id")
    .eq("user_id", user.id)
    .eq("role", role)
    .eq("status", "pending")
    .maybeSingle();

  const { data, error } = pending
    ? await supabaseAdmin
        .from("account_deletion_requests")
        .update(fields)
        .eq("id", pending.id)
        .select()
        .single()
    : await supabaseAdmin
        .from("account_deletion_requests")
        .insert({ ...fields, user_id: user.id, role })
        .select()
        .single();
  if (error || !data) return c.json({ error: error?.message ?? "Request failed" }, 400);

  for (const r of clearing) await stepAway(user.id, r);

  return c.json({ request: data }, 201);
});

export default app;
