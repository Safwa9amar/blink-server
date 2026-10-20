import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { algiersDate, SUMMARY_TZ } from "../../lib/blink-cash-summary";
import { dateRange } from "../../lib/mcp-util";
import { defineTool } from "../registry";
import { createdFrom, createdTo, must } from "./_shared";
import { VERSION } from "../version";
import { env } from "../../config/env";

const ORDER_STATUS = [
  "searching", "heading_to_store", "preparation", "pickup", "on_the_way",
  "delivered", "canceled", "merchant_rejected", "processing",
] as const;
const TRIP_STATUS = ["upcoming", "completed", "under_review", "canceled"] as const;
const USER_ROLES = ["customer", "rider", "merchant", "agent"] as const;
const TX_TYPES = ["deposit", "withdrawal"] as const;
const TX_STATUS = ["pending", "completed", "cancelled"] as const;
const SUM_ROW_CAP = 5000;

type Counter = { gte?: string; lt?: string };

async function count(table: string, r: Counter, filters: Record<string, string>, tsCol = "created_at") {
  let q = supabaseAdmin.from(table).select("id", { count: "exact", head: true });
  for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
  if (r.gte) q = q.gte(tsCol, r.gte);
  if (r.lt) q = q.lt(tsCol, r.lt);
  const res = await q;
  if (res.error) throw new Error(`Database error: ${res.error.message}`);
  return res.count ?? 0;
}

async function byKey(table: string, col: string, keys: readonly string[], r: Counter, extra: Record<string, string> = {}) {
  const counts = await Promise.all(keys.map((k) => count(table, r, { ...extra, [col]: k })));
  return Object.fromEntries(keys.map((k, i) => [k, counts[i]]));
}

export const opsSummary = defineTool({
  name: "ops_summary",
  title: "Operations summary",
  description:
    "Platform counts for a date range (read-only; Algiers days, default today, `to` inclusive): orders by status and type, trips by status, new users by role, Blink Cash by type x status with completed DZD sums (`amount_sum_truncated` past 5000 rows).",
  roles: ["ops_admin", "finance_admin"],
  input: { created_from: createdFrom, created_to: createdTo },
  handler: async (a) => {
    const today = algiersDate(new Date());
    const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    // A single bound means that one day (only `to` given must not become today→past).
    const fromD = a.created_from ?? (isDay(a.created_to) ? a.created_to! : today);
    const toD = a.created_to ?? (isDay(a.created_from) ? a.created_from! : today);
    const r = dateRange(fromD, toD);

    const [orders, orderTypes, trips, users, tx] = await Promise.all([
      byKey("orders", "status", ORDER_STATUS, r),
      byKey("orders", "type", ["merchant", "shopper", "courier", "ride"], r),
      byKey("trips", "status", TRIP_STATUS, r),
      byKey("users", "role", USER_ROLES, r),
      Promise.all(
        TX_TYPES.map(async (type) => {
          const counts = await byKey("transactions", "status", TX_STATUS, r, { type });
          let sq = supabaseAdmin.from("transactions").select("amount").eq("type", type).eq("status", "completed");
          if (r.gte) sq = sq.gte("created_at", r.gte);
          if (r.lt) sq = sq.lt("created_at", r.lt);
          const rows = must(await sq.limit(SUM_ROW_CAP)).data as unknown as { amount: number | string }[];
          const sum = Math.round(rows.reduce((s, x) => s + Number(x.amount), 0) * 100) / 100;
          return [type, { counts, completed_amount_dzd: sum, amount_sum_truncated: rows.length >= SUM_ROW_CAP }] as const;
        })
      ),
    ]);
    return {
      data: {
        range: { from: fromD, to: toD, timezone: SUMMARY_TZ, gte: r.gte, lt: r.lt },
        orders_by_status: orders,
        orders_by_type: orderTypes,
        trips_by_status: trips,
        new_users_by_role: users,
        transactions: Object.fromEntries(tx),
      },
    };
  },
});

export const serverInfo = defineTool({
  name: "server_info",
  title: "Server info",
  description:
    "Blink server build info (read-only): version, uptime, Node version, environment, and the active support-bot AI provider/model/enabled flag (never any key).",
  input: {},
  handler: async () => {
    const { data } = await supabaseAdmin
      .from("ai_settings")
      .select("provider, model, bot_enabled")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return {
      data: {
        name: "blink-server",
        version: VERSION,
        uptime_seconds: Math.round(process.uptime()),
        node_version: process.version,
        environment: env.NODE_ENV,
        ai: data ?? { provider: env.DEFAULT_AI_PROVIDER, model: null, bot_enabled: null },
        now: new Date().toISOString(),
      },
    };
  },
});
