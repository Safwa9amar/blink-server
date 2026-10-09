import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryOnNetworkError } from "./db-retry";

/** A fake write that answers with the given statuses in order. */
function writes(...statuses: number[]) {
  let calls = 0;
  const write = async () => ({ status: statuses[Math.min(calls++, statuses.length - 1)] });
  return { write, calls: () => calls };
}

describe("retryOnNetworkError", () => {
  it("replays a write that never reached the database", async () => {
    const w = writes(0, 0, 201);
    const res = await retryOnNetworkError(w.write, { delayMs: 0 });
    assert.equal(res.status, 201);
    assert.equal(w.calls(), 3);
  });

  it("gives up after the last attempt and returns the network failure", async () => {
    const w = writes(0);
    const res = await retryOnNetworkError(w.write, { attempts: 3, delayMs: 0 });
    assert.equal(res.status, 0);
    assert.equal(w.calls(), 3);
  });

  it("never replays a real database answer", async () => {
    for (const status of [201, 400, 409]) {
      const w = writes(status, 201);
      const res = await retryOnNetworkError(w.write, { delayMs: 0 });
      assert.equal(res.status, status);
      assert.equal(w.calls(), 1);
    }
  });
});
