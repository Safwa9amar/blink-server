import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { algiersDate } from "../../lib/blink-cash-summary";
import { dateRange } from "../../lib/mcp-util";
import { getAiConfig } from "../../lib/ai-settings";
import { retrieveKb } from "../../lib/support-kb-retrieval";
import { getKbIndexStatus } from "../../lib/support-kb-index";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

type Row = Record<string, unknown>;
const cut = (s: unknown, n: number) => (typeof s === "string" ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
const fullName = (u?: { first_name: string | null; last_name: string | null }) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || null : null;

async function namesFor(ids: (string | null | undefined)[]): Promise<Map<string, string | null>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const out = new Map<string, string | null>();
  if (!uniq.length) return out;
  const { data } = must(await supabaseAdmin.from("users").select("id, first_name, last_name").in("id", uniq));
  for (const u of data as { id: string; first_name: string | null; last_name: string | null }[]) out.set(u.id, fullName(u));
  return out;
}

/** Default range = last 7 Algiers days when nothing is given; a single bound means that one day. */
function rangeOrWeek(from?: string, to?: string) {
  const isDay = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const today = algiersDate(new Date());
  if (!from && !to) {
    const start = algiersDate(Date.now() - 6 * 86_400_000);
    return { r: dateRange(start, today), from: start, to: today };
  }
  const f = from ?? (isDay(to) ? to! : today);
  const t = to ?? (isDay(from) ? from! : today);
  return { r: dateRange(f, t), from: f, to: t };
}

// ───────────────────────── help center / KB ─────────────────────────

export const searchHelpCenter = defineTool({
  name: "search_help_center",
  title: "Search help center",
  description:
    "Find the most relevant PUBLISHED help-center excerpts (support knowledge base, hybrid semantic+keyword) for a question. Returns title, type, locale, excerpt, score. Use it to answer support questions.",
  input: {
    query: z.string().min(2).max(300).describe("The question or keywords"),
    role: z.enum(["customer", "rider", "merchant", "agent"]).default("customer").describe("App role asking"),
    locale: z.enum(["en", "fr", "ar"]).optional().describe("Preferred language (default en)"),
  },
  handler: async (a) => {
    const cfg = await getAiConfig();
    const res = await retrieveKb({ role: a.role, locale: a.locale ?? "en", query: a.query, cfg, topK: 5 });
    const items = res.results.map((r) => ({
      article_id: r.article_id,
      title: r.title,
      type: r.type,
      locale: r.locale,
      excerpt: cut(r.content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(), 700),
      score: Math.round(r.score * 1000) / 1000,
    }));
    return { data: { mode: res.mode, items }, rowCount: items.length };
  },
});

export const kbIndexStatus = defineTool({
  name: "kb_index_status",
  title: "Support KB index status",
  description:
    "Status of the support knowledge-base RAG index: embedding provider/model, published vs indexed articles, chunks per locale, stale articles, last sync/error.",
  roles: ["support_admin"],
  input: {},
  handler: async () => {
    const status = await getKbIndexStatus(await getAiConfig());
    return { data: { ...status }, rowCount: 1 };
  },
});

// ───────────────────────── support desk summary ─────────────────────────

const CONV_CAP = 1000;
const SLA_CAP = 400;
const CHUNK = 150;
const mins = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;

export const supportDeskSummary = defineTool({
  name: "support_desk_summary",
  title: "Support desk summary",
  description:
    "Support desk metrics for conversations created in a range (Algiers days, default last 7): counts by status, escalations, SLA breaches (first response / resolution vs priority policy), CSAT avg+count, per-agent handled/resolved/avg CSAT.",
  roles: ["support_admin", "ops_admin"],
  input: { created_from: createdFrom, created_to: createdTo },
  handler: async (a) => {
    const { r, from, to } = rangeOrWeek(a.created_from, a.created_to);
    const { data: convs } = must(
      await supabaseAdmin
        .from("support_conversations")
        .select("id, status, priority, assigned_agent_id, csat_rating, created_at, updated_at")
        .gte("created_at", r.gte!)
        .lt("created_at", r.lt!)
        .order("created_at", { ascending: false })
        .limit(CONV_CAP + 1)
    );
    const all = convs as unknown as {
      id: string; status: string; priority: string; assigned_agent_id: string | null;
      csat_rating: number | null; created_at: string; updated_at: string;
    }[];
    const truncated = all.length > CONV_CAP;
    const rows = all.slice(0, CONV_CAP);

    const by_status: Record<string, number> = { bot: 0, waiting: 0, assigned: 0, resolved: 0 };
    let csatSum = 0, csatN = 0;
    const agents = new Map<string, { handled: number; resolved: number; csatSum: number; csatN: number }>();
    for (const c of rows) {
      by_status[c.status] = (by_status[c.status] ?? 0) + 1;
      if (c.csat_rating != null) { csatSum += c.csat_rating; csatN++; }
      if (c.assigned_agent_id) {
        const g = agents.get(c.assigned_agent_id) ?? { handled: 0, resolved: 0, csatSum: 0, csatN: 0 };
        g.handled++;
        if (c.status === "resolved") g.resolved++;
        if (c.csat_rating != null) { g.csatSum += c.csat_rating; g.csatN++; }
        agents.set(c.assigned_agent_id, g);
      }
    }

    // Escalated conversations = anything past `bot`. SLA clock starts at the escalation message.
    const esc = rows.filter((c) => c.status !== "bot");
    const slaRows = esc.slice(0, SLA_CAP);
    const policies = new Map<string, { fr: number; res: number }>();
    const pol = must(await supabaseAdmin.from("support_sla_policies").select("priority, first_response_minutes, resolution_minutes"));
    for (const p of pol.data as { priority: string; first_response_minutes: number; resolution_minutes: number }[]) {
      policies.set(p.priority, { fr: p.first_response_minutes, res: p.resolution_minutes });
    }
    const escAt = new Map<string, string>();
    const firstAgent = new Map<string, string>();
    for (let i = 0; i < slaRows.length; i += CHUNK) {
      const ids = slaRows.slice(i, i + CHUNK).map((c) => c.id);
      const { data } = must(
        await supabaseAdmin
          .from("support_messages")
          .select("conversation_id, sender, meta, created_at")
          .in("conversation_id", ids)
          .in("sender", ["system", "agent"])
          .order("created_at", { ascending: true })
          .limit(5000)
      );
      for (const m of data as unknown as { conversation_id: string; sender: string; meta: { type?: string } | null; created_at: string }[]) {
        if (m.sender === "system" && m.meta?.type === "escalated" && !escAt.has(m.conversation_id)) escAt.set(m.conversation_id, m.created_at);
        if (m.sender === "agent" && !firstAgent.has(m.conversation_id)) firstAgent.set(m.conversation_id, m.created_at);
      }
    }
    const now = new Date().toISOString();
    let frBreaches = 0, resBreaches = 0, measured = 0;
    for (const c of slaRows) {
      const p = policies.get(c.priority);
      const start = escAt.get(c.id);
      if (!p || !start) continue;
      measured++;
      const fa = firstAgent.get(c.id);
      if (mins(start, fa && fa > start ? fa : now) > p.fr) frBreaches++;
      if (mins(start, c.status === "resolved" ? c.updated_at : now) > p.res) resBreaches++;
    }

    const names = await namesFor([...agents.keys()]);
    const per_agent = [...agents.entries()]
      .map(([id, g]) => ({
        agent_id: id,
        name: names.get(id) ?? null,
        handled: g.handled,
        resolved: g.resolved,
        avg_csat: g.csatN ? Math.round((g.csatSum / g.csatN) * 100) / 100 : null,
      }))
      .sort((x, y) => y.handled - x.handled)
      .slice(0, 30);

    return {
      data: {
        range: { from, to },
        conversations: rows.length,
        truncated,
        by_status,
        escalations: esc.length,
        sla: {
          measured,
          measured_truncated: esc.length > SLA_CAP,
          first_response_breaches: frBreaches,
          resolution_breaches: resBreaches,
          note: "Clock starts at the escalation message; resolution uses updated_at as resolved time; open items measured to now.",
        },
        csat: { count: csatN, average: csatN ? Math.round((csatSum / csatN) * 100) / 100 : null },
        per_agent,
      },
      rowCount: rows.length,
    };
  },
});

// ───────────────────────── broadcasts / news ─────────────────────────

export const listBroadcasts = defineTool({
  name: "list_broadcasts",
  title: "List broadcasts and news",
  description:
    "Scheduled broadcast notifications (kind=notifications; status pending|sending|sent|failed|canceled; channels, target roles, scheduled_at, sent counts) or news posts (kind=news; status, pinned, push, views, clicks). Newest first.",
  roles: ["support_admin", "ops_admin"],
  input: {
    kind: z.enum(["notifications", "news"]),
    status: z.enum(["pending", "sending", "sent", "failed", "canceled", "published", "scheduled", "draft"]).optional(),
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    if (a.kind === "notifications") {
      if (a.status && ["published", "scheduled", "draft"].includes(a.status)) throw new Error("Use pending|sending|sent|failed|canceled for notifications");
      let q = supabaseAdmin
        .from("scheduled_notifications")
        .select("id, type, title, channels, target_roles, sms_lang, scheduled_at, status, recipients, pushed, sms_sent, sent_at, error, created_at", { count: "exact" });
      if (a.status) q = q.eq("status", a.status);
      const { data, count } = must(await q.order("scheduled_at", { ascending: false }).range(from, to));
      const items = (data as unknown as Row[]).map((x) => ({ ...x, error: cut(x.error, 300) }));
      return { data: listResult(items, count, offset), rowCount: items.length };
    }
    if (a.status && !["published", "scheduled", "draft"].includes(a.status)) throw new Error("Use published|scheduled|draft for news");
    let q = supabaseAdmin
      .from("news")
      .select("id, slug, category, title:content_eng->>title, target_roles, status, pinned, push, push_sent_at, views, clicks, published_at, scheduled_at, expires_at, created_at", { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Row[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ───────────────────────── account deletion requests ─────────────────────────

export const listAccountDeletionRequests = defineTool({
  name: "list_account_deletion_requests",
  title: "List account deletion requests",
  description:
    "In-app account/role deletion requests: status (pending|completed|cancelled), scope (account|role), role, reason, requested/processed dates, processor and user name. Newest first. No contact details.",
  roles: ["support_admin", "hr_admin", "ops_admin"],
  input: {
    status: z.enum(["pending", "completed", "cancelled"]).optional(),
    scope: z.enum(["account", "role"]).optional(),
    role: z.enum(["customer", "rider", "merchant", "agent"]).optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin
      .from("account_deletion_requests")
      .select("id, user_id, role, scope, reason, status, processed_at, processed_by, created_at, snap_name:user_snapshot->>name", { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    if (a.scope) q = q.eq("scope", a.scope);
    if (a.role) q = q.eq("role", a.role);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as (Row & { user_id: string; processed_by: string | null; snap_name: string | null; reason: string | null })[];
    const names = await namesFor(rows.flatMap((x) => [x.user_id, x.processed_by]));
    const items = rows.map(({ snap_name, ...x }) => ({
      ...x,
      reason: cut(x.reason, 300),
      user_name: snap_name ?? names.get(x.user_id) ?? null,
      processed_by_name: x.processed_by ? names.get(x.processed_by) ?? null : null,
    }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ───────────────────────── referrals ─────────────────────────

const REF_CAP = 5000;

export const referralStats = defineTool({
  name: "referral_stats",
  title: "Referral stats",
  description:
    "Referral program for a range (Algiers days, default last 7): codes applied, rewards issued (completed count + DZD total) and top referrers (name + count). Reads at most 5000 rows.",
  roles: ["ops_admin", "commerce_admin"],
  input: { created_from: createdFrom, created_to: createdTo },
  handler: async (a) => {
    const { r, from, to } = rangeOrWeek(a.created_from, a.created_to);
    const [applied, done] = await Promise.all([
      supabaseAdmin
        .from("referrals")
        .select("referrer_id, status", { count: "exact" })
        .gte("created_at", r.gte!)
        .lt("created_at", r.lt!)
        .limit(REF_CAP),
      supabaseAdmin
        .from("referrals")
        .select("reward_amount", { count: "exact" })
        .eq("status", "completed")
        .gte("completed_at", r.gte!)
        .lt("completed_at", r.lt!)
        .limit(REF_CAP),
    ]);
    const ap = must(applied);
    const dn = must(done);
    const appliedRows = ap.data as unknown as { referrer_id: string; status: string }[];
    const doneRows = dn.data as unknown as { reward_amount: number }[];
    const counts = new Map<string, number>();
    for (const x of appliedRows) counts.set(x.referrer_id, (counts.get(x.referrer_id) ?? 0) + 1);
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10);
    const names = await namesFor(top.map(([id]) => id));
    return {
      data: {
        range: { from, to },
        codes_applied: ap.count ?? appliedRows.length,
        rewards_issued: {
          count: dn.count ?? doneRows.length,
          amount_dzd: doneRows.reduce((s, x) => s + Number(x.reward_amount ?? 0), 0),
          amount_truncated: (dn.count ?? 0) > REF_CAP,
        },
        top_referrers: top.map(([id, n]) => ({ user_id: id, name: names.get(id) ?? null, referrals: n })),
        top_truncated: (ap.count ?? 0) > REF_CAP,
      },
      rowCount: appliedRows.length,
    };
  },
});

// ───────────────────────── caller's own staff inbox ─────────────────────────

const INBOX_WINDOW = 200;

/** Read when read_at >= last_at, or the "mark all" watermark >= last_at (no watermark = last 7 days unread). */
export function isStaffNotificationUnread(lastAt: string, readAt: string | null, watermark: string | null, now = Date.now()) {
  if (readAt && readAt >= lastAt) return false;
  if (watermark) return watermark < lastAt;
  return Date.parse(lastAt) >= now - 7 * 86_400_000;
}

export const myStaffNotifications = defineTool({
  name: "my_staff_notifications",
  title: "My staff notifications",
  description:
    "YOUR OWN staff inbox (dashboard bell), unread first then newest: kind, severity, summary, occurrences, created/last_at, read_at. Scans the latest 200 events. Never shows other staff.",
  input: { unread_only: z.boolean().optional(), limit: limitField, offset: offsetField },
  handler: async (a, ctx) => {
    const uid = ctx.user.id; // caller only — no user input is accepted
    const { offset, limit } = page(a);
    const [notifs, reads, state] = await Promise.all([
      supabaseAdmin
        .from("staff_notifications")
        .select("id, kind, severity, entity_id, summary, occurrences, created_at, last_at")
        .order("last_at", { ascending: false })
        .limit(INBOX_WINDOW),
      supabaseAdmin.from("staff_notification_reads").select("notification_id, read_at").eq("user_id", uid),
      supabaseAdmin.from("staff_notification_state").select("read_all_at").eq("user_id", uid).maybeSingle(),
    ]);
    const n = must(notifs).data as unknown as (Row & { id: string; last_at: string })[];
    const readMap = new Map((must(reads).data as unknown as { notification_id: string; read_at: string }[]).map((x) => [x.notification_id, x.read_at]));
    const watermark = (must(state).data as { read_all_at: string } | null)?.read_all_at ?? null;
    let items = n.map((x) => {
      const read_at = readMap.get(x.id) ?? null;
      return { ...x, unread: isStaffNotificationUnread(x.last_at, read_at, watermark), read_at };
    });
    const unreadTotal = items.filter((x) => x.unread).length;
    if (a.unread_only) items = items.filter((x) => x.unread);
    items = [...items.filter((x) => x.unread), ...items.filter((x) => !x.unread)];
    const slice = items.slice(offset, offset + limit);
    return {
      data: { ...listResult(slice, items.length, offset), unread_in_window: unreadTotal, window: INBOX_WINDOW },
      rowCount: slice.length,
    };
  },
});

// ───────────────────────── audit (super_admin only) ─────────────────────────

export const staffActivityAudit = defineTool({
  name: "staff_activity_audit",
  title: "Staff activity audit",
  description:
    "Super-admin only. log=mcp: staff MCP/assistant tool calls (tool, ok, error, rows, duration, source, staff name). log=access: dashboard access changes (action, role change, actor, target). Filters: staff_user_id, source, dates.",
  roles: ["super_admin"],
  input: {
    log: z.enum(["mcp", "access"]).default("mcp"),
    staff_user_id: uuidField("Staff user (mcp: caller; access: actor)").optional(),
    source: z.enum(["mcp", "assistant"]).optional().describe("log=mcp only"),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    if (a.log === "access") {
      let q = supabaseAdmin
        .from("staff_access_events")
        .select("id, actor_id, target_id, action, from_role, to_role, note, created_at", { count: "exact" });
      if (a.staff_user_id) q = q.eq("actor_id", a.staff_user_id);
      if (r.gte) q = q.gte("created_at", r.gte);
      if (r.lt) q = q.lt("created_at", r.lt);
      const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
      const rows = data as unknown as (Row & { actor_id: string | null; target_id: string | null; note: string | null })[];
      const names = await namesFor(rows.flatMap((x) => [x.actor_id, x.target_id]));
      const items = rows.map((x) => ({
        ...x,
        note: cut(x.note, 200),
        actor_name: x.actor_id ? names.get(x.actor_id) ?? null : null,
        target_name: x.target_id ? names.get(x.target_id) ?? null : null,
      }));
      return { data: listResult(items, count, offset), rowCount: items.length };
    }
    let q = supabaseAdmin
      .from("staff_mcp_audit")
      .select("id, user_id, tool, ok, error, row_count, duration_ms, source, created_at", { count: "exact" });
    if (a.staff_user_id) q = q.eq("user_id", a.staff_user_id);
    if (a.source) q = q.eq("source", a.source);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const rows = data as unknown as (Row & { user_id: string | null; error: string | null })[];
    const names = await namesFor(rows.map((x) => x.user_id));
    const items = rows.map((x) => ({ ...x, error: cut(x.error, 200), staff_name: x.user_id ? names.get(x.user_id) ?? null : null }));
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

// ───────────────────────── alerts ─────────────────────────

export const listAlerts = defineTool({
  name: "list_alerts",
  title: "List alerts",
  description:
    "Server monitoring: alert rules (metric, comparator, threshold, severity, enabled, channels) plus recent alert events (active|resolved, value, fired/resolved times), newest first. Filter events by status.",
  roles: ["ops_admin"],
  input: { status: z.enum(["active", "resolved"]).optional().describe("Events filter"), limit: limitField, offset: offsetField },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    let q = supabaseAdmin
      .from("alert_events")
      .select("id, rule_id, status, severity, value, message, fired_at, resolved_at", { count: "exact" });
    if (a.status) q = q.eq("status", a.status);
    const [ev, rules] = await Promise.all([
      q.order("fired_at", { ascending: false }).range(from, to),
      supabaseAdmin
        .from("alert_rules")
        .select("id, name, metric, comparator, threshold, severity, enabled, channels")
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    const e = must(ev);
    const items = e.data as unknown as Row[];
    return {
      data: { rules: must(rules).data, events: listResult(items, e.count, offset) },
      rowCount: items.length,
    };
  },
});

export const PLATFORM_TOOLS = [
  searchHelpCenter,
  kbIndexStatus,
  supportDeskSummary,
  listBroadcasts,
  listAccountDeletionRequests,
  referralStats,
  myStaffNotifications,
  staffActivityAudit,
  listAlerts,
];
