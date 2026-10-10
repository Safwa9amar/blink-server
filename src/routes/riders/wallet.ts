import { releaseRiderRequests, riderWallet } from "../../lib/dispatch";
import { RIDER_NOT_VERIFIED } from "../../lib/rider-access";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, ErrorSchema, errorResponses, json, router } from "../../openapi";
import {
  availabilitySchema,
  AvailabilityResponse,
  RiderShiftResponse,
  RiderWalletResponse,
} from "../../validators/rider-jobs";
import { RiderNotVerifiedError } from "../../validators/riders";

const app = router();

// ─── Rider: Blink Cash balance ───────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/wallet",
    operationId: "getRiderWallet",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderWalletResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    return c.json({ wallet: await riderWallet(user.id) }, 200);
  }
);

// ─── Rider: shift status (online flag + acceptance/cancellation rates) ─
app.openapi(
  createRoute({
    method: "get",
    path: "/shift",
    operationId: "getRiderShift",
    tags: ["riders"],
    security: bearer,
    responses: { 200: json(RiderShiftResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const user = c.get("user");
    const [{ data: profile }, { data: trips }, { data: declines }] = await Promise.all([
      supabaseAdmin.from("rider_profiles").select("is_available").eq("user_id", user.id).maybeSingle(),
      supabaseAdmin
        .from("trips")
        .select("status, created_at")
        .eq("rider_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabaseAdmin
        .from("rider_order_declines")
        .select("created_at")
        .eq("rider_id", user.id)
        .eq("stage", "offer")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    const accepted = trips?.length ?? 0;
    const declined = declines?.length ?? 0;
    const canceled = (trips ?? []).filter((t) => t.status === "canceled").length;
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
    return c.json(
      {
        is_available: profile?.is_available ?? false,
        acceptance_rate: accepted + declined ? pct(accepted, accepted + declined) : 100,
        cancellation_rate: pct(canceled, accepted),
      },
      200
    );
  }
);

// ─── Rider: go online / offline (shift) ──────────────────────────────
app.openapi(
  createRoute({
    method: "patch",
    path: "/availability",
    operationId: "updateRiderAvailability",
    tags: ["riders"],
    security: bearer,
    request: { body: { ...json(availabilitySchema), required: true } },
    responses: {
      200: json(AvailabilityResponse),
      400: errorResponses[400],
      403: json(RiderNotVerifiedError, "Rider not verified"),
      503: json(ErrorSchema, "Service unavailable"),
    },
  }),
  async (c) => {
    const user = c.get("user");
    const { is_available } = c.req.valid("json");
    // Only a verified rider may go online (going offline is always allowed).
    // One conditional write: no check-then-write race with a staff un-approval.
    if (is_available) {
      const { data: on, error: onError } = await supabaseAdmin
        .from("rider_profiles")
        .update({ is_available: true })
        .eq("user_id", user.id)
        .eq("verification_status", "approved")
        .select("user_id")
        .maybeSingle();
      if (onError) return c.json({ error: "Service unavailable, please retry" }, 503);
      if (!on) return c.json(RIDER_NOT_VERIFIED, 403);
      return c.json({ is_available: true }, 200);
    }
    const { data, error } = await supabaseAdmin
      .from("rider_profiles")
      .update({ is_available })
      .eq("user_id", user.id)
      .select("is_available")
      .single();
    if (error || !data) return c.json({ error: error?.message ?? "Rider profile not found" }, 400);
    // Offline riders get no offers: stores waiting on this one can pick someone else.
    if (!data.is_available) await releaseRiderRequests(user.id);
    return c.json({ is_available: data.is_available }, 200);
  }
);

export default app;
