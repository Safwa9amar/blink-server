import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { algiersDate } from "../../lib/blink-cash-summary";
import { dateRange, sanitizeSearch } from "../../lib/mcp-util";
import { computeAgentDuesBatch } from "../../lib/agent-finance";
import { riderWallet } from "../../lib/dispatch";
import { RIDER_DOCUMENT_KEYS } from "../../lib/rider-verification";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

// ---------- pure helpers (unit-tested in mcp-fieldops.test.ts) ----------

export const MAX_RANGE_DAYS = 92;
export const ROW_CAP = 20_000;
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;
const ALGIERS_OFFSET_MS = 3_600_000;

export interface FieldRange {
  from: string; // YYYY-MM-DD (Algiers)
  to: string; // YYYY-MM-DD inclusive
  days: number;
  gte: string;
  lt: string;
}

/** Resolve optional created_from/created_to to an Algiers day range (default: last `defaultDays` days to today). Throws when > 92 days or inverted. */
export function resolveRange(from?: string, to?: string, defaultDays = 7, now: Date = new Date()): FieldRange {
  const toDay = to ? algiersDate(dateRange(undefined, to).lt ? new Date(Date.parse(dateRange(undefined, to).lt!) - 1) : now) : algiersDate(now);
  const fromDay = from
    ? algiersDate(dateRange(from).gte!)
    : algiersDate(Date.parse(`${toDay}T00:00:00Z`) - (defaultDays - 1) * DAY_MS);
  const days = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS) + 1;
  if (days < 1) throw new Error("created_from must be on or before created_to");
  if (days > MAX_RANGE_DAYS) throw new Error(`Range too large: ${days} days (max ${MAX_RANGE_DAYS})`);
  const r = dateRange(fromDay, toDay);
  return { from: fromDay, to: toDay, days, gte: r.gte!, lt: r.lt! };
}

/** Every Algiers date from..to inclusive. */
export function dayKeys(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** One bucket per day (zeros included). `pick` returns the instant and optional amount of a row. */
export function bucketByDay<T>(
  rows: readonly T[],
  days: readonly string[],
  at: (r: T) => string | null | undefined,
  amount?: (r: T) => number
): { date: string; count: number; amount: number }[] {
  const m = new Map(days.map((d) => [d, { date: d, count: 0, amount: 0 }]));
  for (const r of rows) {
    const ts = at(r);
    const b = ts ? m.get(algiersDate(ts)) : undefined;
    if (!b) continue;
    b.count++;
    if (amount) b.amount += amount(r);
  }
  return [...m.values()].map((b) => ({ ...b, amount: Math.round(b.amount * 100) / 100 }));
}

/** Whole minutes between an instant and now (null when missing); never negative. */
export function minutesSince(ts: string | null | undefined, now: Date = new Date()): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((now.getTime() - ms) / 60_000));
}

/** Minutes from `start` to `end` (one decimal), null when either is missing or end < start. */
export function minutesBetween(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const d = (Date.parse(end) - Date.parse(start)) / 60_000;
  return Number.isNaN(d) || d < 0 ? null : Math.round(d * 10) / 10;
}

/** Hour of day 0..23 in Africa/Algiers (UTC+1). */
export function algiersHour(ts: string): number {
  return new Date(Date.parse(ts) + ALGIERS_OFFSET_MS).getUTCHours();
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const fullName = (u?: { first_name: string | null; last_name: string | null } | null) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null;

// ---------- bounded reads ----------

/** Paginated read capped at ROW_CAP rows; `truncated` is true when the cap was hit. */
async function readCapped<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  cap = ROW_CAP
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let from = 0; from < cap; from += PAGE_SIZE) {
    const res = await build(from, Math.min(from + PAGE_SIZE, cap) - 1);
    if (res.error) throw new Error(`Database error: ${res.error.message}`);
    const chunk = (res.data ?? []) as T[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

async function exactCount(q: PromiseLike<{ count: number | null; error: { message: string } | null }>) {
  const res = await q;
  if (res.error) throw new Error(`Database error: ${res.error.message}`);
  return res.count ?? 0;
}

async function namesByIds(ids: string[]) {
  const out = new Map<string, { first_name: string | null; last_name: string | null; wilaya: string | null }>();
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 200) {
    const { data } = must(
      await supabaseAdmin.from("users").select("id, first_name, last_name, wilaya").in("id", uniq.slice(i, i + 200))
    );
    for (const u of data as unknown as { id: string; first_name: string | null; last_name: string | null; wilaya: string | null }[]) {
      out.set(u.id, u);
    }
  }
  return out;
}

const rangeInput = { created_from: createdFrom, created_to: createdTo };
const rangeOut = (r: FieldRange) => ({ from: r.from, to: r.to, days: r.days, timezone: "Africa/Algiers" });
const PEOPLE = ["ops_admin", "hr_admin"] as const;

// ---------- 1. list_riders ----------

export const listRiders = defineTool({
  name: "list_riders",
  title: "List riders",
  description:
    "List riders (read-only), newest first: rider code, name, vehicle type/class/category, verification status, online flag, minutes since last location ping (no coordinates), wilaya. Filters: verification_status, vehicle_type, available, q (name or code).",
  roles: [...PEOPLE],
  input: {
    verification_status: z.enum(["not_submitted", "pending", "approved", "rejected"]).optional(),
    vehicle_type: z.enum(["bicycle", "motorcycle"]).optional(),
    available: z.boolean().optional().describe("Online/available flag"),
    q: z.string().max(80).optional().describe("Name or rider code"),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("rider_profiles")
      .select("user_id, rider_id, vehicle_type, vehicle_class, verification_status, is_available, location_updated_at, created_at", { count: "exact" });
    if (a.verification_status) q = q.eq("verification_status", a.verification_status);
    if (a.vehicle_type) q = q.eq("vehicle_type", a.vehicle_type);
    if (a.available !== undefined) q = q.eq("is_available", a.available);
    const term = a.q ? sanitizeSearch(a.q) : "";
    if (term) {
      const { data: us } = must(
        await supabaseAdmin
          .from("users")
          .select("id")
          .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`)
          .limit(200)
      );
      const ids = (us as unknown as { id: string }[]).map((u) => u.id);
      q = q.or(ids.length ? `rider_id.ilike.%${term}%,user_id.in.(${ids.join(",")})` : `rider_id.ilike.%${term}%`);
    }
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as {
      user_id: string; rider_id: string; vehicle_type: string | null; vehicle_class: string | null; verification_status: string;
      is_available: boolean; location_updated_at: string | null;
    }[];
    const userIds = rows.map((r) => r.user_id);
    const [names, vehicles] = await Promise.all([
      namesByIds(userIds),
      userIds.length
        ? supabaseAdmin.from("vehicles").select("user_id, category").in("user_id", userIds)
        : Promise.resolve({ data: [] as { user_id: string; category: string }[], error: null }),
    ]);
    const cat = new Map(((vehicles.data ?? []) as { user_id: string; category: string }[]).map((v) => [v.user_id, v.category]));
    const items = rows.map((r) => ({
      user_id: r.user_id,
      rider_id: r.rider_id,
      name: fullName(names.get(r.user_id)),
      wilaya: names.get(r.user_id)?.wilaya ?? null,
      vehicle_type: r.vehicle_type,
      vehicle_class: r.vehicle_class,
      vehicle_category: cat.get(r.user_id) ?? null,
      verification_status: r.verification_status,
      available: r.is_available,
      last_location_minutes_ago: minutesSince(r.location_updated_at),
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ---------- 2. rider_verification_queue ----------

export const riderVerificationQueue = defineTool({
  name: "rider_verification_queue",
  title: "Rider verification queue",
  description:
    "Riders with verification pending or rejected (read-only), oldest update first: per-document status + staff note and upload ages in days. No file URLs. Filter: status (pending|rejected).",
  roles: [...PEOPLE],
  input: {
    status: z.enum(["pending", "rejected"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("rider_profiles")
      .select("user_id, rider_id, vehicle_type, vehicle_class, verification_status, documents, created_at, updated_at", { count: "exact" });
    q = a.status ? q.eq("verification_status", a.status) : q.in("verification_status", ["pending", "rejected"]);
    const { data, count } = must(await q.order("updated_at", { ascending: true }).range(from, to));
    const rows = data as unknown as {
      user_id: string; rider_id: string; vehicle_type: string | null; vehicle_class: string | null; verification_status: string;
      documents: Record<string, { status: string; note: string | null; uploaded_at: string } | undefined> | null;
      updated_at: string;
    }[];
    const names = await namesByIds(rows.map((r) => r.user_id));
    const items = rows.map((r) => {
      const docs = Object.fromEntries(
        RIDER_DOCUMENT_KEYS.map((k) => {
          const d = r.documents?.[k];
          return [k, d ? { status: d.status, note: d.note ?? null, uploaded_days_ago: minutesSince(d.uploaded_at) === null ? null : Math.floor(minutesSince(d.uploaded_at)! / 1440) } : null];
        })
      );
      const uploads = RIDER_DOCUMENT_KEYS.map((k) => r.documents?.[k]?.uploaded_at).filter((x): x is string => !!x).sort();
      return {
        user_id: r.user_id,
        rider_id: r.rider_id,
        name: fullName(names.get(r.user_id)),
        vehicle_type: r.vehicle_type,
        vehicle_class: r.vehicle_class,
        verification_status: r.verification_status,
        documents: docs,
        oldest_upload_days_ago: uploads.length ? Math.floor(minutesSince(uploads[0])! / 1440) : null,
        updated_days_ago: Math.floor((minutesSince(r.updated_at) ?? 0) / 1440),
      };
    });
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ---------- 3. get_rider_stats ----------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const getRiderStats = defineTool({
  name: "get_rider_stats",
  title: "Rider stats",
  description:
    "One rider over a date range (default last 7 days, max 92; Algiers days; DZD): trips by status, net payouts, penalties, avg rating received, declines, canceled orders, and wallet summary. rider = user id or code (BK-RR-…).",
  roles: ["ops_admin"],
  input: { rider: z.string().min(3).max(40).describe("Rider user id (uuid) or rider code"), ...rangeInput },
  handler: async (a) => {
    const r = resolveRange(a.created_from, a.created_to);
    let userId = a.rider;
    let code: string | null = null;
    if (!UUID_RE.test(a.rider)) {
      const { data } = must(await supabaseAdmin.from("rider_profiles").select("user_id, rider_id").eq("rider_id", a.rider).maybeSingle());
      if (!data) throw new Error("Rider not found");
      userId = (data as unknown as { user_id: string }).user_id;
      code = a.rider;
    } else {
      const { data } = must(await supabaseAdmin.from("rider_profiles").select("rider_id").eq("user_id", userId).maybeSingle());
      if (!data) throw new Error("Rider not found");
      code = (data as unknown as { rider_id: string }).rider_id;
    }
    const inRange = <T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(q: T) =>
      q.gte("created_at", r.gte).lt("created_at", r.lt);
    const TRIP_STATUSES = ["upcoming", "completed", "under_review", "canceled"] as const;
    const [trips, ratings, declines, canceledOrders, wallet] = await Promise.all([
      readCapped<{ status: string; net_payout: number | string; penalty_amount: number | string | null }>((f, t) =>
        inRange(supabaseAdmin.from("trips").select("status, net_payout, penalty_amount").eq("rider_id", userId)).range(f, t)
      ),
      readCapped<{ rider_rating: number }>((f, t) =>
        inRange(supabaseAdmin.from("orders").select("rider_rating").eq("rider_id", userId).not("rider_rating", "is", null) as any).range(f, t)
      ),
      readCapped<{ stage: string }>((f, t) =>
        inRange(supabaseAdmin.from("rider_order_declines").select("stage").eq("rider_id", userId)).range(f, t)
      ),
      exactCount(inRange(supabaseAdmin.from("orders").select("id", { count: "exact", head: true }).eq("rider_id", userId).eq("status", "canceled"))),
      riderWallet(userId),
    ]);
    const byStatus: Record<string, number> = Object.fromEntries(TRIP_STATUSES.map((s) => [s, 0]));
    let net = 0;
    let penalties = 0;
    for (const t of trips.rows) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
      if (t.status === "completed") net += Number(t.net_payout ?? 0);
      penalties += Number(t.penalty_amount ?? 0);
    }
    const rs = ratings.rows.map((x) => Number(x.rider_rating));
    const declineByStage: Record<string, number> = { offer: 0, post_accept: 0 };
    for (const d of declines.rows) declineByStage[d.stage] = (declineByStage[d.stage] ?? 0) + 1;
    return {
      data: {
        rider: { user_id: userId, rider_id: code },
        range: rangeOut(r),
        trips_by_status: byStatus,
        completed_trips: byStatus.completed,
        net_payouts_dzd: round2(net),
        penalties_dzd: round2(penalties),
        avg_rating_received: rs.length ? round2(rs.reduce((s, x) => s + x, 0) / rs.length) : null,
        ratings_count: rs.length,
        declines: { total: declines.rows.length, ...declineByStage },
        canceled_orders: canceledOrders,
        wallet_dzd: wallet,
        truncated: trips.truncated || ratings.truncated || declines.truncated,
      },
      rowCount: 1,
    };
  },
});

// ---------- 4. list_agents ----------

export const listAgents = defineTool({
  name: "list_agents",
  title: "List agents",
  description:
    "List cash agents (read-only), newest first: agent code, name, shops (name, open/closed, review status, primary, wilaya/address), commercial-register doc status, completed operations last 30 days, current dues (DZD), last operation date. Filter: q (name or code).",
  roles: [...PEOPLE],
  input: { q: z.string().max(80).optional().describe("Name or agent code"), limit: limitField, offset: offsetField },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin.from("agent_profiles").select("user_id, agent_id, documents, created_at", { count: "exact" });
    const term = a.q ? sanitizeSearch(a.q) : "";
    if (term) {
      const { data: us } = must(
        await supabaseAdmin.from("users").select("id").or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%`).limit(200)
      );
      const ids = (us as unknown as { id: string }[]).map((u) => u.id);
      q = q.or(ids.length ? `agent_id.ilike.%${term}%,user_id.in.(${ids.join(",")})` : `agent_id.ilike.%${term}%`);
    }
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as {
      user_id: string; agent_id: string;
      documents: { commercial_register_front?: { status: string }; commercial_register_back?: { status: string } } | null;
    }[];
    const ids = rows.map((r) => r.user_id);
    const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
    const [names, shopsRes, ops, dues, lastOps] = await Promise.all([
      namesByIds(ids),
      ids.length
        ? supabaseAdmin.from("agent_shops").select("user_id, shop_name, status, review_status, is_primary, address").in("user_id", ids)
        : Promise.resolve({ data: [], error: null }),
      ids.length
        ? readCapped<{ agent_id: string }>((f, t) =>
            supabaseAdmin.from("transactions").select("agent_id").in("agent_id", ids).eq("status", "completed").gte("created_at", since).range(f, t)
          )
        : Promise.resolve({ rows: [], truncated: false }),
      ids.length ? computeAgentDuesBatch(ids) : Promise.resolve(new Map()),
      Promise.all(
        ids.map(async (id) => {
          const { data: d } = await supabaseAdmin
            .from("transactions").select("created_at").eq("agent_id", id).eq("status", "completed")
            .order("created_at", { ascending: false }).limit(1);
          return [id, (d as { created_at: string }[] | null)?.[0]?.created_at ?? null] as const;
        })
      ),
    ]);
    if (shopsRes.error) throw new Error(`Database error: ${shopsRes.error.message}`);
    const shops = (shopsRes.data ?? []) as unknown as { user_id: string; shop_name: string; status: string; review_status: string; is_primary: boolean; address: string | null }[];
    const opsBy = new Map<string, number>();
    for (const o of ops.rows) opsBy.set(o.agent_id, (opsBy.get(o.agent_id) ?? 0) + 1);
    const last = new Map(lastOps);
    const items = rows.map((r) => ({
      user_id: r.user_id,
      agent_id: r.agent_id,
      name: fullName(names.get(r.user_id)),
      wilaya: names.get(r.user_id)?.wilaya ?? null,
      commercial_register: { front: r.documents?.commercial_register_front?.status ?? null, back: r.documents?.commercial_register_back?.status ?? null },
      shops: shops.filter((s) => s.user_id === r.user_id).map((s) => ({
        name: s.shop_name, status: s.status, review_status: s.review_status, primary: s.is_primary, address: s.address,
      })),
      operations_last_30d: opsBy.get(r.user_id) ?? 0,
      dues_dzd: dues.get(r.user_id)?.total_dues ?? null,
      credit_dzd: dues.get(r.user_id)?.credit ?? null,
      last_operation_at: last.get(r.user_id) ?? null,
    }));
    return { data: { ...listResult(items, count, offset), operations_truncated: ops.truncated }, rowCount: items.length };
  },
});

// ---------- 5. live_ops_snapshot ----------

export const liveOpsSnapshot = defineTool({
  name: "live_ops_snapshot",
  title: "Live ops snapshot",
  description:
    "Right-now operations (read-only): orders searching for a rider (count, oldest wait min), active orders by status, stuck searching orders (> stuck_minutes, default 15), riders online, pending cash requests, support chats waiting for an agent.",
  roles: ["ops_admin", "support_admin"],
  input: { stuck_minutes: z.number().int().min(1).max(1440).optional().describe("Searching longer than this is stuck (default 15)") },
  handler: async (a) => {
    const stuck = a.stuck_minutes ?? 15;
    const now = new Date();
    const stuckBefore = new Date(now.getTime() - stuck * 60_000).toISOString();
    const freshAfter = new Date(now.getTime() - 10 * 60_000).toISOString();
    const head = (t: string) => supabaseAdmin.from(t).select("id", { count: "exact", head: true });
    const ACTIVE = ["processing", "heading_to_store", "preparation", "pickup", "on_the_way"] as const;
    const [searching, stuckN, oldest, active, online, fresh, cash, cashOldest, waiting, waitingOldest] = await Promise.all([
      exactCount(head("orders").eq("status", "searching")),
      exactCount(head("orders").eq("status", "searching").lt("created_at", stuckBefore)),
      supabaseAdmin.from("orders").select("created_at").eq("status", "searching").order("created_at", { ascending: true }).limit(1),
      Promise.all(ACTIVE.map((s) => exactCount(head("orders").eq("status", s)))),
      exactCount(head("rider_profiles").eq("is_available", true)),
      exactCount(head("rider_profiles").eq("is_available", true).gte("location_updated_at", freshAfter)),
      Promise.all(["deposit", "withdrawal"].map((t) => exactCount(head("transactions").eq("status", "pending").eq("type", t)))),
      supabaseAdmin.from("transactions").select("created_at").eq("status", "pending").order("created_at", { ascending: true }).limit(1),
      exactCount(head("support_conversations").eq("status", "waiting")),
      supabaseAdmin.from("support_conversations").select("last_message_at").eq("status", "waiting").order("last_message_at", { ascending: true }).limit(1),
    ]);
    const first = (r: { data: unknown }, col: string) => ((r.data as Record<string, string>[] | null)?.[0]?.[col] ?? null);
    return {
      data: {
        at: now.toISOString(),
        orders_searching: { count: searching, oldest_wait_minutes: minutesSince(first(oldest, "created_at"), now) },
        stuck_searching: { threshold_minutes: stuck, count: stuckN },
        active_orders_by_status: Object.fromEntries(ACTIVE.map((s, i) => [s, active[i]])),
        riders: { online_available: online, online_with_location_last_10min: fresh },
        pending_cash_requests: { deposit: cash[0], withdrawal: cash[1], oldest_minutes: minutesSince(first(cashOldest, "created_at"), now) },
        support_waiting_for_agent: { count: waiting, oldest_minutes: minutesSince(first(waitingOldest, "last_message_at"), now) },
      },
    };
  },
});

// ---------- 6. metrics_timeseries ----------

const METRICS = ["orders", "gmv", "trips", "new_users", "blink_cash"] as const;

export const metricsTimeseries = defineTool({
  name: "metrics_timeseries",
  title: "Metrics time series",
  description:
    "Daily series (Algiers days, default last 7, max 92; DZD): orders created/delivered/canceled, gmv (delivered totals), trips completed, new users by role, Blink Cash deposit/withdrawal volume. metric omitted = all. Row-capped at 20k (truncated flag).",
  roles: ["ops_admin"],
  input: { metric: z.enum(METRICS).optional(), ...rangeInput },
  handler: async (a) => {
    const r = resolveRange(a.created_from, a.created_to);
    const days = dayKeys(r.from, r.to);
    const want = (m: (typeof METRICS)[number]) => !a.metric || a.metric === m;
    const between = <T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(q: T, col: string) =>
      q.gte(col, r.gte).lt(col, r.lt);
    let truncated = false;
    const out: Record<string, unknown> = {};
    const cap = <T,>(x: { rows: T[]; truncated: boolean }) => {
      truncated ||= x.truncated;
      return x.rows;
    };
    const jobs: Promise<void>[] = [];

    if (want("orders")) {
      jobs.push((async () => {
        const [created, delivered, canceled] = await Promise.all([
          readCapped<{ created_at: string }>((f, t) => between(supabaseAdmin.from("orders").select("created_at"), "created_at").order("created_at").range(f, t)),
          readCapped<{ delivered_at: string }>((f, t) => between(supabaseAdmin.from("orders").select("delivered_at").eq("status", "delivered"), "delivered_at").order("delivered_at").range(f, t)),
          readCapped<{ canceled_at: string }>((f, t) => between(supabaseAdmin.from("orders").select("canceled_at").eq("status", "canceled"), "canceled_at").order("canceled_at").range(f, t)),
        ]);
        const c = bucketByDay(cap(created), days, (x) => x.created_at);
        const d = bucketByDay(cap(delivered), days, (x) => x.delivered_at);
        const x = bucketByDay(cap(canceled), days, (y) => y.canceled_at);
        out.orders = days.map((date, i) => ({ date, created: c[i].count, delivered: d[i].count, canceled: x[i].count }));
      })());
    }
    if (want("gmv")) {
      jobs.push((async () => {
        const rows = cap(await readCapped<{ delivered_at: string; total: number | string }>((f, t) =>
          between(supabaseAdmin.from("orders").select("delivered_at, total").eq("status", "delivered"), "delivered_at").order("delivered_at").range(f, t)));
        out.gmv_dzd = bucketByDay(rows, days, (x) => x.delivered_at, (x) => Number(x.total ?? 0)).map((b) => ({ date: b.date, delivered_orders: b.count, gmv: b.amount }));
      })());
    }
    if (want("trips")) {
      jobs.push((async () => {
        const rows = cap(await readCapped<{ created_at: string }>((f, t) =>
          between(supabaseAdmin.from("trips").select("created_at").eq("status", "completed"), "created_at").order("created_at").range(f, t)));
        out.trips_completed = bucketByDay(rows, days, (x) => x.created_at).map((b) => ({ date: b.date, count: b.count }));
      })());
    }
    if (want("new_users")) {
      jobs.push((async () => {
        const rows = cap(await readCapped<{ created_at: string; role: string }>((f, t) =>
          between(supabaseAdmin.from("users").select("created_at, role"), "created_at").order("created_at").range(f, t)));
        const roles = ["customer", "rider", "merchant", "agent"];
        const per = roles.map((role) => bucketByDay(rows.filter((x) => x.role === role), days, (x) => x.created_at));
        out.new_users = days.map((date, i) => ({ date, ...Object.fromEntries(roles.map((role, j) => [role, per[j][i].count])) }));
      })());
    }
    if (want("blink_cash")) {
      jobs.push((async () => {
        const rows = cap(await readCapped<{ completed_at: string; type: string; amount: number | string }>((f, t) =>
          between(supabaseAdmin.from("transactions").select("completed_at, type, amount").eq("status", "completed"), "completed_at").order("completed_at").range(f, t)));
        const dep = bucketByDay(rows.filter((x) => x.type === "deposit"), days, (x) => x.completed_at, (x) => Number(x.amount));
        const wd = bucketByDay(rows.filter((x) => x.type === "withdrawal"), days, (x) => x.completed_at, (x) => Number(x.amount));
        out.blink_cash_dzd = days.map((date, i) => ({ date, deposits: dep[i].amount, deposits_count: dep[i].count, withdrawals: wd[i].amount, withdrawals_count: wd[i].count }));
      })());
    }
    await Promise.all(jobs);
    return { data: { range: rangeOut(r), ...out, truncated }, rowCount: days.length };
  },
});

// ---------- 7. top_performers ----------

export const topPerformers = defineTool({
  name: "top_performers",
  title: "Top performers",
  description:
    "Top stores (delivered orders + GMV DZD), riders (completed trips + avg rating) and agents (completed operations + volume DZD) over a range (default 7 days, max 92). limit per list default 5, max 20.",
  roles: ["ops_admin"],
  input: { limit: z.number().int().optional().describe("Per list, default 5, max 20"), ...rangeInput },
  handler: async (a) => {
    const r = resolveRange(a.created_from, a.created_to);
    const n = Math.min(20, Math.max(1, Math.trunc(a.limit ?? 5)));
    const between = <T extends { gte: (c: string, v: string) => T; lt: (c: string, v: string) => T }>(q: T, col: string) =>
      q.gte(col, r.gte).lt(col, r.lt);
    const [orders, trips, tx] = await Promise.all([
      readCapped<{ store_id: string | null; rider_id: string | null; total: number | string; rider_rating: number | null }>((f, t) =>
        between(supabaseAdmin.from("orders").select("store_id, rider_id, total, rider_rating").eq("status", "delivered"), "delivered_at").order("delivered_at").range(f, t)),
      readCapped<{ rider_id: string }>((f, t) =>
        between(supabaseAdmin.from("trips").select("rider_id").eq("status", "completed"), "created_at").order("created_at").range(f, t)),
      readCapped<{ agent_id: string; amount: number | string }>((f, t) =>
        between(supabaseAdmin.from("transactions").select("agent_id, amount").eq("status", "completed").not("agent_id", "is", null) as any, "completed_at").order("completed_at").range(f, t)),
    ]);
    const storeAgg = new Map<string, { orders: number; gmv: number }>();
    const ratingAgg = new Map<string, { sum: number; n: number }>();
    for (const o of orders.rows) {
      if (o.store_id) {
        const s = storeAgg.get(o.store_id) ?? { orders: 0, gmv: 0 };
        s.orders++; s.gmv += Number(o.total ?? 0);
        storeAgg.set(o.store_id, s);
      }
      if (o.rider_id && o.rider_rating != null) {
        const x = ratingAgg.get(o.rider_id) ?? { sum: 0, n: 0 };
        x.sum += Number(o.rider_rating); x.n++;
        ratingAgg.set(o.rider_id, x);
      }
    }
    const riderAgg = new Map<string, number>();
    for (const t of trips.rows) riderAgg.set(t.rider_id, (riderAgg.get(t.rider_id) ?? 0) + 1);
    const agentAgg = new Map<string, { ops: number; volume: number }>();
    for (const t of tx.rows) {
      const x = agentAgg.get(t.agent_id) ?? { ops: 0, volume: 0 };
      x.ops++; x.volume += Number(t.amount ?? 0);
      agentAgg.set(t.agent_id, x);
    }
    const topStores = [...storeAgg].sort((x, y) => y[1].orders - x[1].orders || y[1].gmv - x[1].gmv).slice(0, n);
    const topRiders = [...riderAgg].sort((x, y) => y[1] - x[1]).slice(0, n);
    const topAgents = [...agentAgg].sort((x, y) => y[1].ops - x[1].ops || y[1].volume - x[1].volume).slice(0, n);
    const storeNames = new Map<string, string>();
    if (topStores.length) {
      const { data } = must(await supabaseAdmin.from("stores").select("id, name").in("id", topStores.map((s) => s[0])));
      for (const s of data as unknown as { id: string; name: string }[]) storeNames.set(s.id, s.name);
    }
    const people = await namesByIds([...topRiders.map((x) => x[0]), ...topAgents.map((x) => x[0])]);
    return {
      data: {
        range: rangeOut(r),
        stores: topStores.map(([id, s]) => ({ store_id: id, name: storeNames.get(id) ?? null, delivered_orders: s.orders, gmv_dzd: round2(s.gmv) })),
        riders: topRiders.map(([id, c]) => {
          const rt = ratingAgg.get(id);
          return { user_id: id, name: fullName(people.get(id)), completed_trips: c, avg_rating: rt ? round2(rt.sum / rt.n) : null, ratings_count: rt?.n ?? 0 };
        }),
        agents: topAgents.map(([id, x]) => ({ user_id: id, name: fullName(people.get(id)), operations: x.ops, volume_dzd: round2(x.volume) })),
        truncated: orders.truncated || trips.truncated || tx.truncated,
      },
      rowCount: topStores.length + topRiders.length + topAgents.length,
    };
  },
});

// ---------- 8. demand_summary ----------

export const demandSummary = defineTool({
  name: "demand_summary",
  title: "Demand summary",
  description:
    "Orders created in a range (default 7 days, max 92): by hour of day (Algiers), by wilaya (store orders only; rides/couriers have no wilaya), unmet demand (canceled with no rider / no_rider), and avg/median minutes to rider assignment.",
  roles: ["ops_admin"],
  input: { ...rangeInput },
  handler: async (a) => {
    const r = resolveRange(a.created_from, a.created_to);
    const { rows, truncated } = await readCapped<{
      created_at: string; type: string; status: string; store_id: string | null; rider_id: string | null;
      rider_assigned_at: string | null; cancel_reason: string | null;
    }>((f, t) =>
      supabaseAdmin.from("orders")
        .select("created_at, type, status, store_id, rider_id, rider_assigned_at, cancel_reason")
        .gte("created_at", r.gte).lt("created_at", r.lt).order("created_at").range(f, t)
    );
    const stats = demandStats(rows);
    const storeCounts = new Map<string, number>();
    for (const o of rows) if (o.store_id) storeCounts.set(o.store_id, (storeCounts.get(o.store_id) ?? 0) + 1);
    const wilayaOf = new Map<string, string | null>();
    const sids = [...storeCounts.keys()];
    for (let i = 0; i < sids.length; i += 200) {
      const { data } = must(await supabaseAdmin.from("stores").select("id, wilaya").in("id", sids.slice(i, i + 200)));
      for (const s of data as unknown as { id: string; wilaya: string | null }[]) wilayaOf.set(s.id, s.wilaya);
    }
    const byWilaya: Record<string, number> = {};
    let noWilaya = 0;
    for (const [sid, c] of storeCounts) {
      const w = wilayaOf.get(sid);
      if (w) byWilaya[w] = (byWilaya[w] ?? 0) + c;
      else noWilaya += c;
    }
    const wilayas = Object.entries(byWilaya).sort((x, y) => y[1] - x[1]).slice(0, 30).map(([wilaya, orders]) => ({ wilaya, orders }));
    return {
      data: {
        range: rangeOut(r),
        total_orders: rows.length,
        by_hour_algiers: stats.byHour,
        by_wilaya_store_orders: wilayas,
        store_orders_without_wilaya: noWilaya,
        non_store_orders: rows.length - [...storeCounts.values()].reduce((s, x) => s + x, 0),
        unmet_demand: stats.unmet,
        rider_assignment_minutes: stats.assignment,
        truncated,
      },
      rowCount: rows.length,
    };
  },
});

/** Pure aggregation behind demand_summary. */
export function demandStats(
  rows: readonly { created_at: string; type: string; status: string; rider_id: string | null; rider_assigned_at: string | null; cancel_reason: string | null }[]
) {
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
  let noRider = 0;
  let canceledNoRider = 0;
  const waits: number[] = [];
  const byType = new Map<string, number[]>();
  for (const o of rows) {
    byHour[algiersHour(o.created_at)].orders++;
    const canceled = o.status === "canceled";
    if (canceled && o.cancel_reason === "no_rider") noRider++;
    if (canceled && !o.rider_id && !o.rider_assigned_at) canceledNoRider++;
    const w = minutesBetween(o.created_at, o.rider_assigned_at);
    if (w !== null) {
      waits.push(w);
      byType.set(o.type, [...(byType.get(o.type) ?? []), w]);
    }
  }
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null);
  return {
    byHour,
    unmet: { canceled_reason_no_rider: noRider, canceled_without_rider: canceledNoRider },
    assignment: {
      sample: waits.length,
      avg: avg(waits),
      median: median(waits),
      by_type: Object.fromEntries([...byType].map(([t, xs]) => [t, { sample: xs.length, avg: avg(xs), median: median(xs) }])),
    },
  };
}

export const FIELD_OPS_TOOLS = [
  listRiders,
  riderVerificationQueue,
  getRiderStats,
  listAgents,
  liveOpsSnapshot,
  metricsTimeseries,
  topPerformers,
  demandSummary,
];
