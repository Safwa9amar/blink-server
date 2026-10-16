import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  afterFailure,
  hashPin,
  isLegacyPinHash,
  lockRemainingSeconds,
  PIN_LOCK_MS,
  PIN_MAX_ATTEMPTS,
  pinFailureBody,
  verifyPin,
} from "./pin";

const sha256 = (pin: string) => createHash("sha256").update(pin).digest("hex");

describe("PIN hashing", () => {
  it("hashes as scrypt$salt$hash, salted per call", async () => {
    const a = await hashPin("1234");
    const b = await hashPin("1234");
    assert.match(a, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });

  it("verifies the right PIN and refuses a wrong one", async () => {
    const hash = await hashPin("4821");
    assert.equal(await verifyPin("4821", hash), true);
    assert.equal(await verifyPin("4822", hash), false);
    assert.equal(await verifyPin("", hash), false);
  });

  it("still verifies a legacy SHA-256 hash, and flags it for rehash", async () => {
    const legacy = sha256("1234");
    assert.equal(isLegacyPinHash(legacy), true);
    assert.equal(await verifyPin("1234", legacy), true);
    assert.equal(await verifyPin("4321", legacy), false);
    assert.equal(isLegacyPinHash(await hashPin("1234")), false);
  });

  it("rejects malformed stored hashes", async () => {
    assert.equal(await verifyPin("1234", "scrypt$"), false);
    assert.equal(await verifyPin("1234", "scrypt$zz$zz"), false);
  });
});

describe("PIN lockout", () => {
  const NOW = new Date("2026-10-16T12:00:00Z");

  it("counts failures without locking before the 5th", () => {
    for (let failed = 0; failed < PIN_MAX_ATTEMPTS - 1; failed++) {
      assert.deepEqual(afterFailure(failed, NOW), {
        pin_failed_attempts: failed + 1,
        pin_locked_until: null,
        locked: false,
      });
    }
  });

  it("locks for 15 minutes on the 5th failure and restarts the count", () => {
    const r = afterFailure(PIN_MAX_ATTEMPTS - 1, NOW);
    assert.equal(r.locked, true);
    assert.equal(r.pin_failed_attempts, 0);
    assert.equal(r.pin_locked_until, new Date(NOW.getTime() + PIN_LOCK_MS).toISOString());
    assert.equal(PIN_LOCK_MS, 15 * 60 * 1000);
  });

  it("reports the seconds left on a lock", () => {
    const until = new Date(NOW.getTime() + 90_000).toISOString();
    assert.equal(lockRemainingSeconds(until, NOW), 90);
    assert.equal(lockRemainingSeconds(until, new Date(NOW.getTime() + 89_500)), 1);
  });

  it("is unlocked once the time has passed, or when never locked", () => {
    const until = new Date(NOW.getTime() + 90_000).toISOString();
    assert.equal(lockRemainingSeconds(until, new Date(NOW.getTime() + 90_000)), 0);
    assert.equal(lockRemainingSeconds(until, new Date(NOW.getTime() + 120_000)), 0);
    assert.equal(lockRemainingSeconds(null, NOW), 0);
    assert.equal(lockRemainingSeconds(undefined, NOW), 0);
  });
});

describe("pinFailureBody", () => {
  it("answers a wrong PIN with a codeless 403 (apps treat it as a wrong PIN)", () => {
    assert.deepEqual(pinFailureBody({ ok: false, reason: "invalid", attempts_left: 3 }), {
      status: 403,
      body: { error: "Invalid PIN" },
    });
  });

  it("answers a lock with 403 pin_locked and retry_after", () => {
    const f = pinFailureBody({ ok: false, reason: "locked", retry_after: 600 });
    assert.equal(f.status, 403);
    assert.deepEqual(f.body, { error: "PIN locked, try again later", code: "pin_locked", retry_after: 600 });
  });

  it("answers a missing PIN with 400", () => {
    assert.deepEqual(pinFailureBody({ ok: false, reason: "not_set" }), {
      status: 400,
      body: { error: "PIN not set up" },
    });
  });
});
