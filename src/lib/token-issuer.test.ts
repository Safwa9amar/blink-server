import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rejectedTokenMessage } from "./token-issuer";

const jwt = (payload: object) =>
  `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

const ONLINE = "https://yrgomuepseaktvbsepre.supabase.co";
const ARCH = "http://10.179.61.94:8000";

describe("rejectedTokenMessage", () => {
  it("a token from this server's own project is just invalid / expired", () => {
    assert.equal(
      rejectedTokenMessage(jwt({ iss: `${ONLINE}/auth/v1` }), ONLINE),
      "Invalid or expired token",
    );
  });

  it("a token from another Supabase project names both projects", () => {
    assert.equal(
      rejectedTokenMessage(jwt({ iss: `${ARCH}/auth/v1` }), ONLINE),
      "Supabase mismatch: token is from 10.179.61.94:8000, this server uses yrgomuepseaktvbsepre.supabase.co",
    );
  });

  it("an undecodable token or one with no issuer falls back to the default", () => {
    assert.equal(rejectedTokenMessage("garbage", ONLINE), "Invalid or expired token");
    assert.equal(rejectedTokenMessage(jwt({ sub: "x" }), ONLINE), "Invalid or expired token");
    assert.equal(rejectedTokenMessage(jwt({ iss: "not a url" }), ONLINE), "Invalid or expired token");
  });
});
