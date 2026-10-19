import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SMS_MAX_CHARS, isSmsLang, smsPhone, smsSegments, smsText } from "./sms-text";

const notif = {
  title: "Weekend promo",
  description: "30% off all rides",
  content_eng: { title: "Weekend promo", description: "30% off all rides" },
  content_fr: { title: "Promo du week-end", description: "-30% sur toutes les courses" },
  content_ar: { title: "عرض نهاية الأسبوع", description: "" },
};

describe("smsText", () => {
  it("uses the chosen language", () => {
    assert.equal(smsText(notif, "fr"), "Blink: Promo du week-end\n-30% sur toutes les courses");
  });
  it("sends a title-only language as the title alone (no mixed languages)", () => {
    assert.equal(smsText(notif, "ar"), "Blink: عرض نهاية الأسبوع");
  });
  it("falls back to the canonical copy when the language is empty", () => {
    assert.equal(smsText({ ...notif, content_fr: null }, "fr"), "Blink: Weekend promo\n30% off all rides");
  });
  it("caps very long texts", () => {
    const long = smsText({ title: "T", description: "x".repeat(2000) }, "en");
    assert.equal(long.length, SMS_MAX_CHARS);
    assert.ok(long.endsWith("…"));
  });
});

describe("smsPhone", () => {
  it("keeps E.164 and normalizes Algerian local forms", () => {
    assert.equal(smsPhone("+213555123456"), "+213555123456");
    assert.equal(smsPhone("0555 12 34 56"), "+213555123456");
    assert.equal(smsPhone("213555123456"), "+213555123456");
    assert.equal(smsPhone("00213555123456"), "+213555123456");
  });
  it("rejects what can't be texted", () => {
    assert.equal(smsPhone(null), null);
    assert.equal(smsPhone(""), null);
    assert.equal(smsPhone("12345"), null);
    assert.equal(smsPhone("0212345678"), null); // landline
  });
});

describe("smsSegments", () => {
  it("counts GSM-7 texts (French accents in the basic set stay GSM)", () => {
    assert.equal(smsSegments("a".repeat(160)), 1);
    assert.equal(smsSegments("a".repeat(161)), 2);
    assert.equal(smsSegments("Promo é è à ù"), 1);
  });
  it("counts extension characters twice", () => {
    assert.equal(smsSegments("€".repeat(80)), 1);
    assert.equal(smsSegments("€".repeat(81)), 2);
  });
  it("switches to Unicode for Arabic or non-GSM accents", () => {
    assert.equal(smsSegments("ع".repeat(70)), 1);
    assert.equal(smsSegments("ع".repeat(71)), 2);
    assert.equal(smsSegments("ê" + "a".repeat(69)), 1);
    assert.equal(smsSegments("ê" + "a".repeat(70)), 2);
  });
});

describe("isSmsLang", () => {
  it("accepts en/fr/ar only", () => {
    assert.ok(isSmsLang("fr"));
    assert.ok(!isSmsLang("de"));
    assert.ok(!isSmsLang(null));
  });
});
