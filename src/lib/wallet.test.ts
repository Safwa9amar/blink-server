import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openingAmount } from "./wallet-backfill";
import { walletError, walletErrorCode, WALLET_ERROR_CODES, WALLET_ERROR_HTTP } from "./wallet";

const raised = (message: string) => ({ message, code: "P0001" });

describe("walletErrorCode", () => {
  it("recognises every code the SQL functions raise", () => {
    for (const code of WALLET_ERROR_CODES) assert.equal(walletErrorCode(raised(code)), code);
  });

  it("ignores other Postgres errors and unknown messages", () => {
    assert.equal(walletErrorCode(null), null);
    assert.equal(walletErrorCode({ message: "insufficient_funds", code: "23505" }), null);
    assert.equal(walletErrorCode(raised("something else")), null);
    assert.equal(walletErrorCode({ message: "not_found" }), "not_found"); // no code on the error: message decides
  });
});

describe("walletError → HTTP", () => {
  it("maps the codes to the statuses the spec lists", () => {
    const status = (code: string) => walletError(raised(code))?.status;
    assert.equal(status("insufficient_funds"), 400);
    assert.equal(status("wallet_frozen"), 403);
    assert.equal(status("wrong_agent"), 403);
    assert.equal(status("not_pending"), 409);
    assert.equal(status("not_completed"), 409);
    assert.equal(status("not_in_review"), 409);
    assert.equal(status("expired"), 410);
    assert.equal(status("not_found"), 404);
  });

  it("carries the code in the body, and nothing for foreign errors", () => {
    assert.deepEqual(walletError(raised("expired"))?.body, {
      error: WALLET_ERROR_HTTP.expired.message,
      code: "expired",
    });
    assert.equal(walletError({ message: "boom", code: "XX000" }), null);
  });
});

describe("openingAmount", () => {
  it("is the whole derived balance when nothing was posted", () => {
    assert.equal(openingAmount(12500, []), 12500);
  });

  it("subtracts what the ledger already posted", () => {
    assert.equal(
      openingAmount(12500, [
        { kind: "deposit", amount: 5000 },
        { kind: "trip", amount: -300 },
      ]),
      7800
    );
  });

  it("ignores adjustments and offer bonuses (derived never counts them) and the opening itself", () => {
    assert.equal(
      openingAmount(10000, [
        { kind: "adjustment", amount: 2000 },
        { kind: "offer_bonus", amount: 500 },
        { kind: "opening_balance", amount: 9000 },
        { kind: "deposit", amount: 1000 },
      ]),
      9000
    );
  });

  it("can be negative (a rider who owes Blink) and rounds to centimes", () => {
    assert.equal(openingAmount(-450, []), -450);
    assert.equal(openingAmount(100.1, [{ kind: "deposit", amount: "0.2" }]), 99.9);
  });
});
