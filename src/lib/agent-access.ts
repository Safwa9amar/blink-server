// Who may handle a rider's pending Blink Cash agent operation (a deposit or
// withdrawal QR): the lookup (POST /transactions/scan-qr) and the confirm /
// cancel (POST /transactions/process). Two rules, in this order:
//   1. The agent works through one of their OWN shops that staff approved
//      (agent_shops.review_status = 'active')        → else `shop_not_approved`.
//   2. The operation is theirs: assigned to them (transactions.agent_id), sent
//      to that very shop (transactions.shop_id), or a walk-in — the rider
//      showed the QR without picking an agent, so agent_id and shop_id are
//      both null (/process then assigns it)           → else `not_your_transaction`.
// Pure (no DB), so it runs under `npm test` (agent-access.test.ts).

export const AGENT_ACCESS_CODES = ["shop_not_approved", "not_your_transaction"] as const;
export type AgentAccessCode = (typeof AGENT_ACCESS_CODES)[number];

/** English `error` text sent beside each code (the app shows its own copy). */
export const AGENT_ACCESS_MESSAGE: Record<AgentAccessCode, string> = {
  shop_not_approved: "Your shop is not approved yet",
  not_your_transaction: "This operation was sent to another agent",
};

/** The shop the agent processes through (an agent_shops row). */
export interface AccessShop {
  id?: string | null;
  user_id?: string | null;
  review_status?: string | null;
}

/** The pending operation (a transactions row). */
export interface AccessTx {
  agent_id: string | null;
  shop_id: string | null;
}

export type AgentAccess = { ok: true } | { ok: false; code: AgentAccessCode };

/** UUIDs compare case-insensitively (a body may use upper case; Postgres returns lower). */
const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function canAgentProcess({
  shop,
  tx,
  agentId,
}: {
  /** The processing shop; null when the agent has none. */
  shop: AccessShop | null;
  tx: AccessTx;
  agentId: string;
}): AgentAccess {
  if (!shop || !sameId(shop.user_id, agentId) || shop.review_status !== "active") {
    return { ok: false, code: "shop_not_approved" };
  }
  // Strict: a missing column (undefined) must NOT read as a walk-in.
  const walkIn = tx.agent_id === null && tx.shop_id === null;
  if (walkIn || sameId(tx.agent_id, agentId) || sameId(tx.shop_id, shop.id)) {
    return { ok: true };
  }
  return { ok: false, code: "not_your_transaction" };
}
