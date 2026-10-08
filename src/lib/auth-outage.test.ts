import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAuthOutage } from "./auth-outage";

describe("isAuthOutage", () => {
  it("network / 5xx failures reaching Supabase Auth are outages, not bad tokens", () => {
    assert.equal(isAuthOutage({ name: "AuthRetryableFetchError", status: 0 }), true);
    assert.equal(isAuthOutage({ name: "AuthRetryableFetchError", status: 502 }), true);
    assert.equal(isAuthOutage({ name: "AuthUnknownError" }), true);
    assert.equal(isAuthOutage({ name: "AuthApiError", status: 500 }), true);
  });

  it("a rejected token is not", () => {
    assert.equal(isAuthOutage({ name: "AuthApiError", status: 401 }), false);
    assert.equal(isAuthOutage({ name: "AuthApiError", status: 403 }), false);
    assert.equal(isAuthOutage({ name: "AuthSessionMissingError", status: 400 }), false);
    assert.equal(isAuthOutage(null), false);
  });
});
