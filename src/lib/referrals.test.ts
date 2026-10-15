import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReferralCodeFromCustomerId, referralInviteUrl } from "./referrals";

describe("referral codes", () => {
  it("formats the customer id as BLINK-<digits>", () => {
    assert.equal(formatReferralCodeFromCustomerId("BK-CU-100009"), "BLINK-100009");
  });

  it("links to the Play listing with the code as install referrer by default", () => {
    assert.equal(
      referralInviteUrl("BLINK-100009", undefined),
      "https://play.google.com/store/apps/details?id=com.astro0666.blink&referrer=referral_code%3DBLINK-100009"
    );
  });

  it("uses REFERRAL_INVITE_BASE_URL when set", () => {
    assert.equal(referralInviteUrl("BLINK-1", "https://blink.dz/invite/"), "https://blink.dz/invite?code=BLINK-1");
    assert.equal(referralInviteUrl("BLINK-1", "https://x.dz/i?src=app"), "https://x.dz/i?src=app&code=BLINK-1");
  });
});
