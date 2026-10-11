import { z } from "@hono/zod-openapi";
import { computeAgentDues } from "../../lib/agent-finance";
import { bookedJobRows, currentJobRow, releaseRiderRequests } from "../../lib/dispatch";
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
  user_snapshot: z
    .object({ name: z.string().nullable(), phone_number: z.string().nullable(), email: z.string().nullable() })
    .nullable(),
});

/**
 * 409 — something in flight would be stranded: `dues` (agent/merchant owes
 * Blink), `active_jobs` (rider holds a delivery in progress or a booked job),
 * `open_orders` (merchant's stores or the customer's own orders not done yet).
 */
const AccountDeletionBlockedSchema = z
  .object({
    error: z.string(),
    code: z.enum(["dues", "active_jobs", "open_orders"]),
  })
  .openapi("AccountDeletionBlocked");
type BlockCode = z.infer<typeof AccountDeletionBlockedSchema>["code"];

const BLOCK_MESSAGES: Record<BlockCode, string> = {
  dues: "Settle your outstanding dues before deleting your account",
  active_jobs: "Finish or cancel your jobs before deleting your account",
  open_orders: "Wait for your open orders to finish before deleting your account",
};

/** Why this user can't leave yet, if anything. */
async function blockReason(userId: string, role: string): Promise<BlockCode | null> {
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
  const { count } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", userId)
    .in("status", [...ACTIVE_ORDER_STATUSES]);
  return count ? "open_orders" : null;
}

// ─── Request account deletion ────────────────────────────────────────
// Files (or refreshes) the user's pending request; staff complete it. Refused
// (409) while the user would leave something stranded — see blockReason.
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

  const blocked = await blockReason(user.id, user.role);
  if (blocked) return c.json({ error: BLOCK_MESSAGES[blocked], code: blocked }, 409);

  const fields = { reason: body.reason ?? null, feedback: body.feedback ?? null };
  const { data: pending } = await supabaseAdmin
    .from("account_deletion_requests")
    .select("id")
    .eq("user_id", user.id)
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
        .insert({ ...fields, user_id: user.id, role: user.role })
        .select()
        .single();
  if (error || !data) return c.json({ error: error?.message ?? "Request failed" }, 400);

  // Riders stop seeing an agent who is leaving.
  if (user.role === "agent") {
    await supabaseAdmin.from("agent_shops").update({ status: "closed" }).eq("user_id", user.id);
  }
  // A leaving rider goes offline: no new offers, held ones go to someone else.
  if (user.role === "rider") {
    await supabaseAdmin.from("rider_profiles").update({ is_available: false }).eq("user_id", user.id);
    await releaseRiderRequests(user.id);
  }
  // Customers stop seeing a leaving merchant's stores.
  if (user.role === "merchant") {
    await supabaseAdmin.from("stores").update({ status: "inactive" }).eq("owner_id", user.id).eq("status", "active");
  }

  return c.json({ request: data }, 201);
});

export default app;
