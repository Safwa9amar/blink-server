import assert from "node:assert/strict";
import { describe, it } from "node:test";

// supabase client needs env at import time; the test swaps `from` for a fake.
process.env.SUPABASE_URL ??= "http://localhost";
process.env.SUPABASE_ANON_KEY ??= "anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "service";
process.env.JWT_SECRET ??= "x".repeat(32);

const { supabaseAdmin } = await import("./supabase");
const { agentDuesFromRows, computeAgentDues, computeAgentDuesBatch } = await import("./agent-finance");

type Row = Record<string, any>;
const TABLES: Record<string, Row[]> = {
  transactions: [
    { id: "t1", agent_id: "a1", status: "completed", type: "deposit", amount: 10000, fees: 200, created_at: "2026-10-01T10:00:00Z", rating: 5 },
    { id: "t2", agent_id: "a1", status: "completed", type: "withdrawal", amount: 3000, fees: 60, created_at: "2026-10-02T10:00:00Z", rating: null },
    { id: "t3", agent_id: "a1", status: "pending", type: "deposit", amount: 999, fees: 20, created_at: "2026-10-03T10:00:00Z", rating: null },
    { id: "t4", agent_id: "a2", status: "completed", type: "withdrawal", amount: 8000, fees: 160, created_at: "2026-10-02T10:00:00Z", rating: 4 },
  ],
  agent_challenge_participants: [
    { agent_id: "a1", status: "won", reward_amount: 500 },
    { agent_id: "a1", status: "lost", reward_amount: 900 },
  ],
  agent_dues_payments: [
    { id: "p1", agent_id: "a1", status: "completed", amount: 1000, created_at: "2026-10-04T10:00:00Z" },
    { id: "p2", agent_id: "a1", status: "failed", amount: 5000, created_at: "2026-10-05T10:00:00Z" },
  ],
};

/** Minimal PostgREST stand-in: eq / in filters, range, awaitable. */
function fakeFrom(table: string) {
  let rows = [...(TABLES[table] ?? [])];
  let range: [number, number] | null = null;
  const q: any = {
    select: () => q,
    order: () => q,
    eq: (k: string, v: any) => ((rows = rows.filter((r) => r[k] === v)), q),
    in: (k: string, vs: any[]) => ((rows = rows.filter((r) => vs.includes(r[k]))), q),
    range: (a: number, b: number) => ((range = [a, b]), q),
    then: (resolve: any, reject: any) =>
      Promise.resolve({ data: range ? rows.slice(range[0], range[1] + 1) : rows, error: null }).then(resolve, reject),
  };
  return q;
}

describe("agent dues: single vs batched", () => {
  it("computeAgentDues and computeAgentDuesBatch agree on the same rows", async () => {
    (supabaseAdmin as any).from = fakeFrom;
    const batch = await computeAgentDuesBatch(["a1", "a2", "a3"]);
    for (const id of ["a1", "a2", "a3"]) {
      assert.deepEqual(batch.get(id), await computeAgentDues(id), id);
    }
    // a1: 10000 - 3000 + platform/tax on fees - 500 reward - 1000 paid
    assert.ok(batch.get("a1")!.total_dues > 5000);
    // a2 only paid out cash → Blink owes the agent (credit)
    assert.ok(batch.get("a2")!.credit > 0);
    assert.deepEqual(batch.get("a3"), agentDuesFromRows([], [], []));
  });
});
