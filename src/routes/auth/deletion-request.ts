import { z } from "@hono/zod-openapi";
import { computeAgentDues } from "../../lib/agent-finance";
import { supabaseAdmin } from "../../lib/supabase";
import { auth } from "../../middleware/auth";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router, rowSchema } from "../../openapi";
import { accountDeletionRequests } from "../../db/schema";

const app = router();

const deletionRequestSchema = z
  .object({
    reason: z.string().max(100).optional(),
    feedback: z.string().max(1000).optional(),
  })
  .openapi("AccountDeletionRequestBody");

const AccountDeletionRequestSchema = rowSchema(accountDeletionRequests, "AccountDeletionRequest", {
  status: z.enum(["pending", "completed", "cancelled"]),
});

// ─── Request account deletion ────────────────────────────────────────
// Files (or refreshes) the user's pending request; staff complete it. Agents
// must settle what they owe Blink first (409).
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
    409: json(ErrorSchema, "Outstanding dues"),
  },
});

app.openapi(route, async (c) => {
  const user = c.get("user");
  const body = c.req.valid("json");

  if (user.role === "agent") {
    const dues = await computeAgentDues(user.id);
    if (dues.total_dues > 0) {
      return c.json({ error: "Settle your outstanding dues before deleting your account" }, 409);
    }
  }

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

  return c.json({ request: data }, 201);
});

export default app;
