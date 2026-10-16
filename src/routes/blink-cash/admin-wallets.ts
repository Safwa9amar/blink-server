// Staff rider wallets: list / statement, manual adjustments and freeze.
// Tagged admin-* so orval skips it; every write is audited and notifies the rider.
import { randomUUID } from "node:crypto";
import { checkAdjust, mapLimit, round2 } from "../../lib/blink-cash-admin";
import { adjustmentCopy, freezeCopy } from "../../lib/blink-cash-copy";
import { recordFinanceAudit } from "../../lib/finance-audit";
import { supabaseAdmin } from "../../lib/supabase";
import { bearer, createRoute, errorResponses, json, router } from "../../openapi";
import {
  AdjustWalletBody,
  AdjustWalletResponse,
  AdminWalletDetailResponse,
  AdminWalletsResponse,
  FreezeResponse,
  ReasonBody,
  UserIdParam,
  WalletEntriesQuery,
  WalletsQuery,
} from "../../validators/blink-cash-admin";
import { callRpc, nameOf, notifyUser, PAGE_SIZE, RIDER_BLINK_CASH_HREF, searchTerm, staff, usersById, type UserLite } from "./admin-shared";

const app = router();

const TAG = ["admin-blink-cash"];
const DEFAULT_ADJUST_LIMIT = 50000;

type WalletRow = {
  id: string;
  user_id: string;
  balance: number | string;
  held: number | string;
  status: "active" | "frozen";
  frozen_reason: string | null;
  frozen_at: string | null;
  backfilled_at: string | null;
};

function toSummary(w: WalletRow, user: UserLite | undefined, lastActivity: string | null) {
  const balance = Number(w.balance);
  const held = Number(w.held);
  return {
    user_id: w.user_id,
    name: nameOf(user),
    phone: user?.phone_number ?? null,
    email: user?.email ?? null,
    balance,
    held,
    available: round2(balance - held),
    status: w.status,
    frozen_reason: w.frozen_reason,
    frozen_at: w.frozen_at,
    backfilled_at: w.backfilled_at,
    last_activity_at: lastActivity,
  };
}

const WALLET_COLS = "id, user_id, balance, held, status, frozen_reason, frozen_at, backfilled_at";

async function lastActivity(walletId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("blink_wallet_entries")
    .select("created_at")
    .eq("wallet_id", walletId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.created_at ?? null;
}

async function findWallet(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("blink_wallets")
    .select(WALLET_COLS)
    .eq("user_id", userId)
    .eq("role", "rider")
    .maybeSingle();
  if (error) throw new Error(`[blink-cash-admin] wallet read failed: ${error.message}`);
  return (data ?? null) as WalletRow | null;
}

async function adjustLimit(): Promise<number> {
  const { data } = await supabaseAdmin.from("blink_cash_settings").select("adjust_limit_finance_admin").eq("id", true).maybeSingle();
  const v = Number(data?.adjust_limit_finance_admin);
  return Number.isFinite(v) ? v : DEFAULT_ADJUST_LIMIT;
}

// ─── List ────────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/wallets",
    operationId: "listBlinkCashWalletsAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { query: WalletsQuery },
    responses: { 200: json(AdminWalletsResponse), 401: errorResponses[401], 403: errorResponses[403] },
  }),
  async (c) => {
    const { q, status, page } = c.req.valid("query");

    let query = supabaseAdmin.from("blink_wallets").select(WALLET_COLS, { count: "exact" }).eq("role", "rider");
    if (status) query = query.eq("status", status);

    const term = q ? searchTerm(q) : "";
    if (term) {
      const { data: matches, error } = await supabaseAdmin
        .from("users")
        .select("id")
        .or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone_number.ilike.%${term}%,email.ilike.%${term}%`)
        .limit(200);
      if (error) throw new Error(`[blink-cash-admin] user search failed: ${error.message}`);
      const ids = (matches ?? []).map((u) => u.id as string);
      if (!ids.length) return c.json({ wallets: [], total: 0, page, page_size: PAGE_SIZE }, 200);
      query = query.in("user_id", ids);
    }

    const { data, count, error } = await query
      .order("updated_at", { ascending: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (error) throw new Error(`[blink-cash-admin] wallets read failed: ${error.message}`);

    const rows = (data ?? []) as WalletRow[];
    const [users, last] = await Promise.all([
      usersById(rows.map((w) => w.user_id)),
      mapLimit(rows, 8, (w) => lastActivity(w.id)),
    ]);
    return c.json(
      {
        wallets: rows.map((w, i) => toSummary(w, users.get(w.user_id), last[i])),
        total: count ?? 0,
        page,
        page_size: PAGE_SIZE,
      },
      200
    );
  }
);

// ─── Detail + statement ──────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "get",
    path: "/admin/wallets/{user_id}",
    operationId: "getBlinkCashWalletAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: UserIdParam, query: WalletEntriesQuery },
    responses: {
      200: json(AdminWalletDetailResponse),
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const { user_id } = c.req.valid("param");
    const { page } = c.req.valid("query");
    const wallet = await findWallet(user_id);
    if (!wallet) return c.json({ error: "Wallet not found" }, 404);

    const [{ data: entries, count, error }, users] = await Promise.all([
      supabaseAdmin
        .from("blink_wallet_entries")
        .select("*", { count: "exact" })
        .eq("wallet_id", wallet.id)
        .order("created_at", { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
      usersById([user_id]),
    ]);
    if (error) throw new Error(`[blink-cash-admin] entries read failed: ${error.message}`);

    const rows = (entries ?? []) as Record<string, unknown>[];
    return c.json(
      {
        wallet: toSummary(wallet, users.get(user_id), (rows[0]?.created_at as string | undefined) ?? null),
        entries: rows,
        total: count ?? 0,
        page,
        page_size: PAGE_SIZE,
      },
      200
    );
  }
);

// ─── Adjust ──────────────────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/wallets/{user_id}/adjust",
    operationId: "adjustBlinkCashWalletAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: UserIdParam, body: { ...json(AdjustWalletBody), required: true } },
    responses: {
      200: json(AdjustWalletResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
      409: errorResponses[409],
    },
  }),
  async (c) => {
    const actor = c.get("user");
    const { user_id } = c.req.valid("param");
    const { amount, reason } = c.req.valid("json");

    const { data: rider } = await supabaseAdmin.from("rider_profiles").select("user_id").eq("user_id", user_id).maybeSingle();
    const wallet = await findWallet(user_id);
    if (!rider && !wallet) return c.json({ error: "Rider not found" }, 404);

    const decision = checkAdjust({
      staffRole: actor.staff_role,
      amount,
      limit: await adjustLimit(),
      balance: Number(wallet?.balance ?? 0),
    });
    if (!decision.ok) {
      const error =
        decision.code === "adjust_limit_exceeded"
          ? "This adjustment is above your limit. Ask a super admin."
          : decision.code === "insufficient_funds"
            ? "The wallet balance cannot go below 0"
            : "Invalid amount";
      return decision.status === 403
        ? c.json({ error, code: decision.code }, 403)
        : decision.status === 409
          ? c.json({ error, code: decision.code }, 409)
          : c.json({ error, code: decision.code }, 400);
    }

    const idem = `adjust:${randomUUID()}`;
    const r = await callRpc<{ id?: string; balance_after?: number | string } | null>("blink_wallet_post", {
      p_user: user_id,
      p_role: "rider",
      p_amount: round2(amount),
      p_kind: "adjustment",
      p_idem: idem,
      p_ref_type: "staff",
      p_memo: reason,
      p_actor: actor.id,
      p_allow_negative: decision.allowNegative,
    });
    if (!r.ok) return r.status === 404 ? c.json(r.body, 404) : c.json(r.body, 409);

    const entry = r.data;
    const balance = Number(entry?.balance_after ?? 0);
    await recordFinanceAudit({
      actorId: actor.id,
      action: "wallet.adjust",
      targetType: "wallet",
      targetId: user_id,
      amount: round2(amount),
      reason,
      details: { entry_id: entry?.id ?? null, idempotency_key: idem, balance_after: balance, staff_role: actor.staff_role },
    });
    await notifyUser({
      userId: user_id,
      role: "rider",
      copy: adjustmentCopy(amount),
      href: RIDER_BLINK_CASH_HREF,
      payload: { kind: "wallet_adjustment" },
      createdBy: actor.id,
    });
    return c.json({ ok: true as const, balance, entry_id: entry?.id ?? null }, 200);
  }
);

// ─── Freeze / unfreeze ───────────────────────────────────────────────
app.openapi(
  createRoute({
    method: "post",
    path: "/admin/wallets/{user_id}/freeze",
    operationId: "freezeBlinkCashWalletAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: UserIdParam, body: { ...json(ReasonBody), required: true } },
    responses: {
      200: json(FreezeResponse),
      400: errorResponses[400],
      401: errorResponses[401],
      403: errorResponses[403],
      404: errorResponses[404],
    },
  }),
  async (c) => {
    const actor = c.get("user");
    const { user_id } = c.req.valid("param");
    const { reason } = c.req.valid("json");

    const { data: rider } = await supabaseAdmin.from("rider_profiles").select("user_id").eq("user_id", user_id).maybeSingle();
    if (!rider && !(await findWallet(user_id))) return c.json({ error: "Rider not found" }, 404);

    // Upsert: a rider who never transacted still gets a (frozen) wallet.
    const { error } = await supabaseAdmin.from("blink_wallets").upsert(
      {
        user_id,
        role: "rider",
        status: "frozen",
        frozen_reason: reason,
        frozen_by: actor.id,
        frozen_at: new Date().toISOString(),
      },
      { onConflict: "user_id,role" }
    );
    if (error) throw new Error(`[blink-cash-admin] freeze failed: ${error.message}`);

    await recordFinanceAudit({ actorId: actor.id, action: "wallet.freeze", targetType: "wallet", targetId: user_id, reason });
    await notifyUser({
      userId: user_id,
      role: "rider",
      copy: freezeCopy(true),
      href: RIDER_BLINK_CASH_HREF,
      payload: { kind: "wallet_frozen" },
      createdBy: actor.id,
    });
    return c.json({ ok: true as const, status: "frozen" as const }, 200);
  }
);

app.openapi(
  createRoute({
    method: "post",
    path: "/admin/wallets/{user_id}/unfreeze",
    operationId: "unfreezeBlinkCashWalletAdmin",
    tags: TAG,
    security: bearer,
    middleware: [staff] as const,
    request: { params: UserIdParam },
    responses: { 200: json(FreezeResponse), 401: errorResponses[401], 403: errorResponses[403], 404: errorResponses[404] },
  }),
  async (c) => {
    const actor = c.get("user");
    const { user_id } = c.req.valid("param");
    const wallet = await findWallet(user_id);
    if (!wallet) return c.json({ error: "Wallet not found" }, 404);

    const { error } = await supabaseAdmin
      .from("blink_wallets")
      .update({ status: "active", frozen_reason: null, frozen_by: null, frozen_at: null })
      .eq("id", wallet.id);
    if (error) throw new Error(`[blink-cash-admin] unfreeze failed: ${error.message}`);

    await recordFinanceAudit({
      actorId: actor.id,
      action: "wallet.unfreeze",
      targetType: "wallet",
      targetId: user_id,
      details: { was_frozen: wallet.status === "frozen", frozen_reason: wallet.frozen_reason },
    });
    if (wallet.status === "frozen") {
      await notifyUser({
        userId: user_id,
        role: "rider",
        copy: freezeCopy(false),
        href: RIDER_BLINK_CASH_HREF,
        payload: { kind: "wallet_unfrozen" },
        createdBy: actor.id,
      });
    }
    return c.json({ ok: true as const, status: "active" as const }, 200);
  }
);

export default app;
