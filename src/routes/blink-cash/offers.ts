import { offerRefusal, type OfferRow } from "../../lib/blink-cash-rules";
import { supabaseAdmin } from "../../lib/supabase";
import { requireRole } from "../../middleware/auth";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import { DepositOfferListResponse } from "../../validators/blink-cash-public";

const app = router();

type Row = Record<string, any>;

const text = (v: Row | null | undefined) => ({
  en: String(v?.en ?? v?.fr ?? v?.ar ?? ""),
  fr: String(v?.fr ?? v?.en ?? v?.ar ?? ""),
  ar: String(v?.ar ?? v?.en ?? v?.fr ?? ""),
});

const toRow = (o: Row): OfferRow => ({
  id: o.id,
  min_deposit: Number(o.min_deposit ?? 0),
  bonus_type: o.bonus_type,
  bonus_value: Number(o.bonus_value),
  max_bonus: o.max_bonus == null ? null : Number(o.max_bonus),
  starts_at: o.starts_at ?? null,
  ends_at: o.ends_at ?? null,
  active: !!o.active,
  per_user_limit: o.per_user_limit ?? null,
  budget: o.budget == null ? null : Number(o.budget),
  used_amount: Number(o.used_amount ?? 0),
});

// ─── GET /blink-cash/offers — deposit offers the rider can still use ─
// Running now or starting later; ended, archived, used-up (per rider or
// budget) offers are left out. Shaped like the app's RiderDepositOffer, with
// the localized copy and the bonus rule; status/timing labels are computed
// client-side from starts_at / ends_at.
app.openapi(
  createRoute({
    method: "get",
    path: "/offers",
    operationId: "listBlinkCashOffers",
    tags: ["blink-cash"],
    security: bearer,
    middleware: [requireRole("rider")] as const,
    responses: {
      200: json(DepositOfferListResponse),
      401: errorResponses[401],
      403: errorResponses[403],
    },
  }),
  async (c) => {
    const user = c.get("user");
    const nowIso = new Date().toISOString();
    const [{ data: offers }, { data: used }] = await Promise.all([
      supabaseAdmin
        .from("blink_cash_offers")
        .select("*")
        .eq("active", true)
        .or(`ends_at.is.null,ends_at.gt.${nowIso}`),
      supabaseAdmin
        .from("transactions")
        .select("offer_id")
        .eq("user_id", user.id)
        .eq("status", "completed")
        .not("offer_id", "is", null)
        .gt("bonus_amount", 0),
    ]);
    const uses = new Map<string, number>();
    for (const t of used ?? []) uses.set(t.offer_id, (uses.get(t.offer_id) ?? 0) + 1);

    const now = new Date();
    const out = (offers ?? [])
      .map((o) => ({ o, row: toRow(o) }))
      // A min-deposit offer is judged at its minimum: it is "usable" if any deposit could earn it.
      .filter(({ row }) => {
        const refusal = offerRefusal(row, Math.max(row.min_deposit, 1), uses.get(row.id) ?? 0, now);
        return refusal === null || refusal === "offer_not_started";
      })
      .map(({ o, row }) => ({
        id: row.id,
        icon: row.bonus_type === "percent" ? "gift.fill" : "banknote",
        title: text(o.title),
        subtitle: text(o.description),
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        status: (row.starts_at && Date.parse(row.starts_at) > now.getTime() ? "upcoming" : "active") as
          | "active"
          | "upcoming",
        min_deposit: row.min_deposit,
        bonus_type: row.bonus_type,
        bonus_value: row.bonus_value,
        max_bonus: row.max_bonus,
        _sort: row.ends_at ? Date.parse(row.ends_at) : Infinity,
      }))
      // Running offers first (ending soonest), then upcoming (starting soonest).
      .sort((a, b) =>
        a.status !== b.status
          ? a.status === "active"
            ? -1
            : 1
          : a.status === "active"
            ? a._sort - b._sort
            : Date.parse(a.starts_at!) - Date.parse(b.starts_at!)
      )
      .map(({ _sort, ...offer }) => offer);

    return c.json({ offers: out }, 200);
  }
);

export default app;
