import { z } from "zod";
import { supabaseAdmin } from "../../lib/supabase";
import { dateRange } from "../../lib/mcp-util";
import { computeAgentDues } from "../../lib/agent-finance";
import { riderWallet } from "../../lib/dispatch";
import { defineTool } from "../registry";
import { createdFrom, createdTo, limitField, listResult, must, offsetField, page, uuidField } from "./_shared";

const ROLES = ["finance_admin", "ops_admin"] as const;
const TX_COLS =
  "id, type, status, method, user_id, agent_id, rider_id, shop_id, amount, fees, total, offer_title, created_at, updated_at";
const TX_DETAIL_COLS = `${TX_COLS}, offer_detail, rating, feedback, rider_rating, rider_feedback`;

export const listTransactions = defineTool({
  name: "list_transactions",
  title: "List Blink Cash transactions",
  description:
    "List Blink Cash deposits/withdrawals newest first (read-only), via an agent or electronic. Filters: user_id (owner), agent_id (processor), type, status (pending|review|completed|cancelled|reversed), created_from/to. Amount, fees, total in DZD.",
  roles: [...ROLES],
  input: {
    user_id: uuidField("Owner (rider or agent) user id").optional(),
    agent_id: uuidField("Agent who processed it").optional(),
    type: z.enum(["deposit", "withdrawal"]).optional(),
    status: z.enum(["pending", "review", "completed", "cancelled", "reversed"]).optional(),
    created_from: createdFrom,
    created_to: createdTo,
    limit: limitField,
    offset: offsetField,
  },
  handler: async (a) => {
    const { offset, from, to } = page(a);
    const r = dateRange(a.created_from, a.created_to);
    let q = supabaseAdmin.from("transactions").select(TX_COLS, { count: "exact" });
    if (a.user_id) q = q.eq("user_id", a.user_id);
    if (a.agent_id) q = q.eq("agent_id", a.agent_id);
    if (a.type) q = q.eq("type", a.type);
    if (a.status) q = q.eq("status", a.status);
    if (r.gte) q = q.gte("created_at", r.gte);
    if (r.lt) q = q.lt("created_at", r.lt);
    const { data, count } = must(await q.order("created_at", { ascending: false }).range(from, to));
    const items = data as unknown as Record<string, unknown>[];
    return { data: listResult(items, count, offset), rowCount: items.length };
  },
});

export const getTransaction = defineTool({
  name: "get_transaction",
  title: "Get transaction",
  description:
    "One Blink Cash transaction by id (read-only): amounts (DZD), fees, status, method, ratings and feedback, plus owner / agent / rider names. The QR pending reference is not returned.",
  roles: [...ROLES],
  input: { transaction_id: uuidField("Transaction id") },
  handler: async ({ transaction_id }) => {
    const { data } = must(
      await supabaseAdmin.from("transactions").select(TX_DETAIL_COLS).eq("id", transaction_id).maybeSingle()
    );
    if (!data) throw new Error("Transaction not found");
    const t = data as unknown as { user_id: string; agent_id: string | null; rider_id: string | null };
    const ids = [...new Set([t.user_id, t.agent_id, t.rider_id].filter(Boolean) as string[])];
    const { data: people } = await supabaseAdmin.from("users").select("id, first_name, last_name, role").in("id", ids);
    return { data: { transaction: data, people: people ?? [] }, rowCount: 1 };
  },
});

export const getWallet = defineTool({
  name: "get_wallet",
  title: "Get Blink Cash wallet",
  description:
    "A user's Blink Cash position in DZD (read-only): rider wallet (total, available, pending), agent dues (owed to Blink, credit, breakdown), merchant dues payments. Sections follow the user's roles. For ledger entries use get_wallet_ledger.",
  roles: [...ROLES],
  input: { user_id: uuidField("User id (from find_users).") },
  handler: async ({ user_id }) => {
    const { data: u } = must(
      await supabaseAdmin.from("users").select("id, first_name, last_name, role, granted_roles").eq("id", user_id).maybeSingle()
    );
    if (!u) throw new Error("User not found");
    const roles = new Set<string>([...((u as { granted_roles?: string[] }).granted_roles ?? []), (u as { role: string }).role]);
    const out: Record<string, unknown> = {
      user: u,
      currency: "DZD",
    };
    if (roles.has("rider")) out.rider_wallet = await riderWallet(user_id);
    if (roles.has("agent")) out.agent_dues = await computeAgentDues(user_id);
    if (roles.has("merchant")) {
      const { data } = must(
        await supabaseAdmin.from("merchant_dues_payments").select("amount, created_at").eq("merchant_id", user_id).eq("status", "completed")
      );
      const rows = data as unknown as { amount: number | string; created_at: string }[];
      out.merchant_dues_payments = {
        completed_count: rows.length,
        completed_total: Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100,
      };
    }
    if (!roles.has("rider") && !roles.has("agent") && !roles.has("merchant")) {
      out.note = "Customer accounts have no Blink Cash wallet.";
    }
    return { data: out, rowCount: 1 };
  },
});
