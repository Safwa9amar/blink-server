import assert from "node:assert/strict";
import { test } from "node:test";
import {
  accountNotVerified,
  AGENT_ONBOARDING,
  MERCHANT_ONBOARDING,
  needsVerification,
  RIDER_ONBOARDING,
} from "./verified-account";

test("reads never need verification", () => {
  for (const m of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(needsVerification(m, "/jobs", []), false);
});

test("writes need it unless allowlisted", () => {
  assert.equal(needsVerification("POST", "/jobs/abc/accept", RIDER_ONBOARDING), true);
  assert.equal(needsVerification("PUT", "/vehicle", RIDER_ONBOARDING), false);
  assert.equal(needsVerification("PUT", "/vehicle/", RIDER_ONBOARDING), false);
  assert.equal(needsVerification("POST", "/vehicle", RIDER_ONBOARDING), true);
  assert.equal(needsVerification("POST", "/anything", []), true);
});

test("{id} matches one segment only", () => {
  assert.equal(needsVerification("PATCH", "/shops/123", AGENT_ONBOARDING), false);
  assert.equal(needsVerification("PATCH", "/shops/123/x", AGENT_ONBOARDING), true);
  assert.equal(needsVerification("POST", "/stores/9/resubmit", MERCHANT_ONBOARDING), false);
  assert.equal(needsVerification("POST", "/orders/9/offer", MERCHANT_ONBOARDING), true);
  assert.equal(needsVerification("POST", "/dues/pay", AGENT_ONBOARDING), true);
});

test("403 body contract", () => {
  assert.deepEqual(accountNotVerified("agent"), {
    error: "Your account must be verified by Blink first",
    code: "account_not_verified",
    role: "agent",
  });
});
