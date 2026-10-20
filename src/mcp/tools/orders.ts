import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange, omitKeys } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ORDER_STATUS = [
  "searching", "heading_to_store", "preparation", "pickup", "on_the_way",
  "delivered", "canceled", "merchant_rejected", "processing",
] as const;
const ORDER_TYPE = ["merchant", "shopper", "courier", "ride"] as const;
const ROLES = ["ops_admin", "support_admin", "commerce_admin", "finance_admin"] as const;

const ORDER_LIST_COLS =
  "id, type, status, merchant_status, customer_id, rider_id, store_id, store_name, subtotal, delivery_fee, service_fee, discount, total, checkout_id, delivery_mode, canceled_by, cancel_reason, created_at, delivered_at, canceled_at";
const ORDER_DETAIL_COLS =
  `${ORDER_LIST_COLS}, pickup_address, destination_address, vehicle_type, scheduled_at, items, courier, ride, ` +
  "accepted_at, prepared_at, rider_assigned_at, picked_up_at, store_rating, store_review, rider_rating, rider_review, rider_tags, merchant_reject_reason, cancel_note, coupon_id, courier_group_id, updated_at";
const PHONE_KEYS = /phone|whatsapp|tel$|mobile/i;

export const listOrders = defineTool({
  name: "list_orders",
  title: "List orders",
  description:
    "List orders newest first (read-only). Types: merchant (store delivery), shopper, courier, ride. Filters: status, type, customer_id, rider_id, store_id, created_from/to. Money in DZD (subtotal, fees, discount, total). Use get_order for line items and the trip.",
  roles: [...ROLES],
  input: {
    status: z.enum(ORDER_STATUS).optional(),
    type: z.enum(ORDER_TYPE).optional(),
    customer_id: uuidField("Customer user id").optional(),
    rider_id: uuidField("Rider user id").optional(),
    store_id: uuidField("Store id (merchant)").optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin.from("orders").select(ORDER_LIST_COLS, { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.type) q = q.eq("type", a.type);
    if (a.customer_id) q = q.eq("customer_id", a.customer_id);
    if (a.rider_id) q = q.eq("rider_id", a.rider_id);
    if (a.store_id) q = q.eq("store_id", a.store_id);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getOrder = defineTool({
  name: "get_order",
  title: "Get order",
  description:
    "One order by id (read-only): list fields plus line items (qty, unit price DZD, pack contents), addresses, timeline, courier/ride details (no phones), ratings, customer and rider names, and the linked trip (payout, distance, status).",
  roles: [...ROLES],
  input: { order_id: uuidField("Order id") },
  handler: async ({ order_id }) => {
    const { data } = must(await supabaseAdmin.from("orders").select(ORDER_DETAIL_COLS).eq("id", order_id).maybeSingle());
    if (!data) throw new Error("Order not found");
    const o = data as unknown as Record<string, unknown> & { customer_id: string; rider_id: string | null };
    const ids = [o.customer_id, o.rider_id].filter(Boolean) as string[];
    const [people, trip] = await Promise.all([
      supabaseAdmin.from("users").select("id, first_name, last_name").in("id", ids),
      supabaseAdmin
        .from("trips")
        .select("id, display_id, status, rider_id, estimated_payout, net_payout, penalty_amount, distance_km, duration_minutes, cancellation_reason, dispute_status, created_at")
        .eq("order_id", order_id)
        .maybeSingle(),
    ]);
    const byId = new Map((people.data ?? []).map((p) => [p.id as string, p]));
    return {
      data: {
        order: { ...o, courier: omitKeys(o.courier, PHONE_KEYS), ride: omitKeys(o.ride, PHONE_KEYS) },
        customer: byId.get(o.customer_id) ?? null,
        rider: o.rider_id ? (byId.get(o.rider_id) ?? null) : null,
        trip: trip.data ?? null,
      },
      rowCount: 1,
    };
  },
});
