import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ratesOf, splitFee } from "./agent-split";
import { PRICING_SEEDS } from "./pricing/catalog";

const DEFAULT = { platform: PRICING_SEEDS.agent_platform_share.rate, tax: PRICING_SEEDS.agent_tax_rate.rate };

describe("splitFee", () => {
  it("splits a fee exactly as before with the seed rates", () => {
    // 40 DZD fee: 20% platform = 8, tax = 1% of 32 = 0.32, net 31.68
    assert.deepEqual(splitFee(40, DEFAULT), { platform: 8, tax: 0.32, net: 31.68 });
  });

  it("uses each transaction's own snapshot, falling back to the default when null", () => {
    const old = { platform_share_rate: 0.1, tax_rate: 0.02 };
    const legacy = { platform_share_rate: null, tax_rate: null };
    assert.deepEqual(splitFee(40, ratesOf(old, DEFAULT)), { platform: 4, tax: 0.72, net: 35.28 });
    assert.deepEqual(splitFee(40, ratesOf(legacy, DEFAULT)), splitFee(40, DEFAULT));
    // snapshot rates arrive from the DB as numeric strings too
    assert.deepEqual(ratesOf({ platform_share_rate: "0.3", tax_rate: "0" }, DEFAULT), { platform: 0.3, tax: 0 });
  });
});
