import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ROLES = ["ops_admin", "support_admin", "finance_admin"] as const;
const TRIP_LIST_COLS =
  "id, display_id, status, rider_id, customer_id, order_id, pickup_label, dropoff_label, estimated_payout, net_payout, penalty_amount, distance_km, duration_minutes, dispute_status, customer_rating, created_at";
const TRIP_DETAIL_COLS =
  `${TRIP_LIST_COLS}, pickup_address, pickup_lat, pickup_lng, dropoff_address, dropoff_lat, dropoff_lng, cancellation_reason, notes, fraud_notice, updated_at`;

export const listTrips = defineTool({
  name: "list_trips",
  title: "List trips",
  description:
    "List rider trips (the rider-side record of a delivery job), newest first (read-only). Status: upcoming | completed | under_review | canceled. " +
    "Filters: status, rider_id, customer_id, created_from/created_to. Payouts are DZD. Returns items + total/next_offset.",
  roles: [...ROLES],
  input: {
    status: z.enum(["upcoming", "completed", "under_review", "canceled"]).optional(),
    rider_id: uuidField("Rider user id").optional(),
    customer_id: uuidField("Customer user id").optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin.from("trips").select(TRIP_LIST_COLS, { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.rider_id) q = q.eq("rider_id", a.rider_id);
    if (a.customer_id) q = q.eq("customer_id", a.customer_id);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getTrip = defineTool({
  name: "get_trip",
  title: "Get trip",
  description:
    "One trip by id (read-only): list fields plus addresses/coordinates, cancellation reason, notes, fraud notice, and the linked order summary (status, total DZD) when order_id is set. Route polyline is not returned.",
  roles: [...ROLES],
  input: { trip_id: uuidField("Trip id") },
  handler: async ({ trip_id }) => {
    const { data } = must(await supabaseAdmin.from("trips").select(TRIP_DETAIL_COLS).eq("id", trip_id).maybeSingle());
    if (!data) throw new Error("Trip not found");
    const t = data as unknown as { order_id: string | null };
    const order = t.order_id
      ? (
          await supabaseAdmin
            .from("orders")
            .select("id, type, status, store_name, total, created_at")
            .eq("id", t.order_id)
            .maybeSingle()
        ).data
      : null;
    return { data: { trip: data, order: order ?? null }, rowCount: 1 };
  },
});
