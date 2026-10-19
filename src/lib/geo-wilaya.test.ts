import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeWilaya, wilayaAt } from "./geo/wilaya";

describe("wilayaAt", () => {
  const cases: [string, number, number, string | null][] = [
    ["Algiers centre", 36.7538, 3.0588, "16"],
    ["Rouiba", 36.7383, 3.2808, "16"],
    ["Blida", 36.47, 2.83, "9"],
    ["Oran", 35.6971, -0.6308, "31"],
    ["Boumerdès", 36.7664, 3.4772, "35"],
    ["Constantine", 36.365, 6.6147, "25"],
    ["Tamanrasset", 22.785, 5.5228, "11"],
    ["Touggourt", 33.1, 6.06, "55"],
    ["Mediterranean sea", 37.8, 3.0, null],
    ["Paris", 48.85, 2.35, null],
  ];
  for (const [name, lat, lng, want] of cases) {
    it(`${name} → ${want}`, () => assert.equal(wilayaAt(lat, lng), want));
  }
});

describe("normalizeWilaya", () => {
  it("codes, with or without padding", () => {
    assert.equal(normalizeWilaya("16"), "16");
    assert.equal(normalizeWilaya("016"), "16");
    assert.equal(normalizeWilaya("09"), "9");
    assert.equal(normalizeWilaya(" 58 "), "58");
    assert.equal(normalizeWilaya("59"), null);
    assert.equal(normalizeWilaya("0"), null);
  });
  it("names in en / fr / ar, any case or accents", () => {
    assert.equal(normalizeWilaya("Alger"), "16");
    assert.equal(normalizeWilaya("ALGIERS"), "16");
    assert.equal(normalizeWilaya("الجزائر"), "16");
    assert.equal(normalizeWilaya("Béjaïa"), "6");
    assert.equal(normalizeWilaya("bejaia"), "6");
    assert.equal(normalizeWilaya("Sétif"), "19");
    assert.equal(normalizeWilaya("سطيف"), "19");
    assert.equal(normalizeWilaya("Boumerdès"), "35");
    assert.equal(normalizeWilaya("Sidi Bel Abbès"), "22");
    assert.equal(normalizeWilaya("El M'Ghair"), "57");
  });
  it("prefixes and code-name forms", () => {
    assert.equal(normalizeWilaya("Wilaya de Blida"), "9");
    assert.equal(normalizeWilaya("ولاية البليدة"), "9");
    assert.equal(normalizeWilaya("16 - Alger"), "16");
  });
  it("unknown / empty → null", () => {
    assert.equal(normalizeWilaya(""), null);
    assert.equal(normalizeWilaya(null), null);
    assert.equal(normalizeWilaya("Atlantis"), null);
  });
});
