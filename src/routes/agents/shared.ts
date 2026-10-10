// Shared helpers for the agent endpoints: shop ownership, the primary shop,
// per-shop processed-volume stats, shop updates and the shop a rider's agent
// deposit / withdrawal goes to.
import { supabaseAdmin } from "../../lib/supabase";

type Row = Record<string, any>;

/** Shops a rider can pick — the /agents/nearby filter (open, staff-verified, named). */
const pickableShops = () =>
  supabaseAdmin
    .from("agent_shops")
    .select("id, user_id")
    .eq("status", "open")
    .eq("review_status", "active")
    .neq("shop_name", "");

/**
 * The agent (and shop) a rider's AGENT deposit / withdrawal goes to (electronic
 * operations have none). A `shopId` picked in the agent locator must be
 * pickable; its owner becomes the agent, and an `agentId` that names someone
 * else is refused. An `agentId` alone (a selection from an older app build)
 * must run a pickable shop; the shop is then left to the processing agent.
 */
export async function operationAgent(
  agentId: string | undefined,
  shopId: string | undefined
): Promise<{ agent_id: string | null; shop_id: string | null } | { error: string }> {
  if (!shopId) {
    if (!agentId) return { agent_id: null, shop_id: null };
    const { data: owned } = await pickableShops().eq("user_id", agentId).limit(1).maybeSingle();
    if (!owned) return { error: "Agent not found or not available" };
    return { agent_id: owned.user_id, shop_id: null };
  }
  const { data: shop } = await pickableShops().eq("id", shopId).maybeSingle();
  if (!shop) return { error: "Agent shop not found or not available" };
  // UUIDs are case-insensitive (the body may use upper case; Postgres returns lower).
  if (agentId && agentId.toLowerCase() !== String(shop.user_id).toLowerCase()) {
    return { error: "Shop does not belong to this agent" };
  }
  return { agent_id: shop.user_id, shop_id: shop.id };
}

/** The agent's primary shop (falls back to their oldest shop). */
export async function primaryShop(userId: string): Promise<Row | null> {
  const { data } = await supabaseAdmin
    .from("agent_shops")
    .select("*")
    .eq("user_id", userId)
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

/** One of the agent's shops, or null when it doesn't exist / isn't theirs. */
export async function ownedShop(userId: string, shopId: string): Promise<Row | null> {
  const { data } = await supabaseAdmin
    .from("agent_shops")
    .select("*")
    .eq("id", shopId)
    .eq("user_id", userId)
    .maybeSingle();
  return data ?? null;
}

/**
 * The shop a rider's operation goes through when this agent handles it (it
 * counts toward that shop's volume): the one the agent chose, else the one the
 * rider picked when this agent owns it, else the agent's primary shop. Null
 * when the agent's choice isn't theirs (or they have no shop at all). Used by
 * /transactions/process and /transactions/scan-qr (no choice there).
 */
export async function processingShop(
  agentId: string,
  chosen: string | undefined,
  riderPick: string | null
): Promise<Row | null> {
  if (chosen) return ownedShop(agentId, chosen);
  return (riderPick ? await ownedShop(agentId, riderPick) : null) ?? primaryShop(agentId);
}

/** Completed-operation volume + count per shop. */
export async function shopStats(shopIds: string[]) {
  const stats = new Map<string, { total_volume: number; operations_count: number }>(
    shopIds.map((id) => [id, { total_volume: 0, operations_count: 0 }])
  );
  if (!shopIds.length) return stats;
  const { data } = await supabaseAdmin
    .from("transactions")
    .select("shop_id, amount")
    .in("shop_id", shopIds)
    .eq("status", "completed");
  for (const t of data ?? []) {
    const s = stats.get(t.shop_id);
    if (!s) continue;
    s.total_volume += Number(t.amount ?? 0);
    s.operations_count++;
  }
  return stats;
}

export function toManagedShop(
  shop: Row,
  stats: Map<string, { total_volume: number; operations_count: number }>
) {
  const s = stats.get(shop.id) ?? { total_volume: 0, operations_count: 0 };
  return {
    ...shop,
    documents: shop.documents ?? {},
    total_volume: Math.round(s.total_volume * 100) / 100,
    operations_count: s.operations_count,
  };
}

/**
 * Apply a shop PATCH. `is_primary: true` promotes this shop (the previous
 * primary is demoted first — one primary per agent is a unique index).
 */
export async function updateShop(userId: string, shopId: string, body: Row) {
  const { is_primary, ...patch } = body;
  if (is_primary) {
    await supabaseAdmin
      .from("agent_shops")
      .update({ is_primary: false })
      .eq("user_id", userId)
      .eq("is_primary", true)
      .neq("id", shopId);
    patch.is_primary = true;
  }
  if (!Object.keys(patch).length) return ownedShop(userId, shopId);
  const { data, error } = await supabaseAdmin
    .from("agent_shops")
    .update(patch)
    .eq("id", shopId)
    .eq("user_id", userId)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}
