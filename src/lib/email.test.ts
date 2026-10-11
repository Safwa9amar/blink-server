import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailLikePattern } from "./email";

describe("emailLikePattern", () => {
  it("escapes LIKE wildcards so they match themselves", () => {
    assert.equal(emailLikePattern("a_b@x.com"), "a\\_b@x.com");
    assert.equal(emailLikePattern("100%@x.com"), "100\\%@x.com");
    assert.equal(emailLikePattern("a\\b@x.com"), "a\\\\b@x.com");
  });
  it("trims and leaves ordinary characters alone", () => {
    assert.equal(emailLikePattern("  Ali.B+tag@Mail.com "), "Ali.B+tag@Mail.com");
  });
});
