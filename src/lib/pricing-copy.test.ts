import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dealDate, pct, pricingDealCopy, type PricingDealEvent } from "./pricing/copy";

describe("pricing deal copy", () => {
  it("formats rates", () => {
    assert.equal(pct(0.03), "3%");
    assert.equal(pct(0.025), "2.5%");
    assert.equal(pct(0.2), "20%");
    assert.equal(pct(0.002), "0.2%");
  });

  it("formats dates in Algeria time", () => {
    assert.equal(dealDate("2026-10-31T23:30:00Z", "en"), "1 Nov 2026");
    assert.equal(dealDate("2026-12-31T00:00:00Z", "fr"), "31 déc. 2026");
  });

  it("created: rate + window in every language", () => {
    const e: PricingDealEvent = {
      kind: "created",
      key: "merchant_commission_rate",
      rate: 0.03,
      defaultRate: 0.05,
      startsAt: "2026-10-31T23:00:00Z",
      endsAt: "2026-12-30T23:00:00Z",
    };
    const c = pricingDealCopy(e);
    assert.equal(c.en.description, "Your Blink commission is 3% from 1 Nov 2026 until 31 Dec 2026.");
    assert.ok(c.fr.description.includes("3%") && c.fr.description.includes("1 nov. 2026"));
    assert.ok(c.ar.description.includes("3%") && c.ar.description.includes("31 ديسمبر 2026"));
  });

  it("open-ended deals say so; one-sided windows only mention one date", () => {
    const base = { kind: "updated", key: "agent_platform_share", rate: 0.1, defaultRate: 0.2 } as const;
    assert.ok(pricingDealCopy(base).en.description.endsWith("until further notice."));
    assert.ok(pricingDealCopy({ ...base, endsAt: "2027-01-01T00:00:00Z" }).en.description.includes("until 1 Jan 2027"));
    assert.ok(!pricingDealCopy({ ...base, endsAt: "2027-01-01T00:00:00Z" }).en.description.includes("from"));
  });

  it("archived: says what it returns to", () => {
    const c = pricingDealCopy({ kind: "archived", key: "merchant_commission_rate", rate: 0.03, defaultRate: 0.05 });
    assert.equal(c.en.description, "Your Blink commission returns to 5%.");
    for (const lang of ["en", "fr", "ar"] as const) {
      assert.ok(c[lang].title.trim());
      assert.ok(c[lang].description.includes("5%"));
    }
  });

  it("every kind × key has non-empty copy", () => {
    for (const kind of ["created", "updated", "archived"] as const) {
      for (const key of ["merchant_commission_rate", "agent_platform_share"] as const) {
        const c = pricingDealCopy({ kind, key, rate: 0.04, defaultRate: 0.2 });
        for (const lang of ["en", "fr", "ar"] as const) {
          assert.ok(c[lang].title && c[lang].description, `${kind} ${key} ${lang}`);
        }
      }
    }
  });
});
