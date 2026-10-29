import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAuthLink, pickLang } from "./email/auth-links";
import { renderAuthEmail } from "./email/auth-templates";

const SB = "https://proj.supabase.co";

describe("buildAuthLink", () => {
  it("adds token_hash + type to an /auth/confirm redirect, keeping params", () => {
    const l = buildAuthLink({ redirectTo: "https://admin.blink.dz/auth/confirm?next=%2Freset&lang=fr", tokenHash: "abc", type: "recovery", supabaseUrl: SB });
    const u = new URL(l);
    assert.equal(u.pathname, "/auth/confirm");
    assert.equal(u.searchParams.get("next"), "/reset");
    assert.equal(u.searchParams.get("lang"), "fr");
    assert.equal(u.searchParams.get("token_hash"), "abc");
    assert.equal(u.searchParams.get("type"), "recovery");
  });
  it("falls back to the Supabase verify URL", () => {
    const l = buildAuthLink({ redirectTo: "https://x.dz/other?a=1", tokenHash: "h", type: "magiclink", supabaseUrl: SB + "/" });
    assert.equal(l, `${SB}/auth/v1/verify?token=h&type=magiclink&redirect_to=${encodeURIComponent("https://x.dz/other?a=1")}`);
  });
  it("handles a missing or invalid redirect", () => {
    assert.equal(buildAuthLink({ redirectTo: "", tokenHash: "h", type: "signup", supabaseUrl: SB }), `${SB}/auth/v1/verify?token=h&type=signup`);
    assert.ok(buildAuthLink({ redirectTo: "not a url", tokenHash: "h", type: "signup", supabaseUrl: SB }).startsWith(SB));
  });
});

describe("pickLang", () => {
  it("prefers redirect lang, then metadata, then fr", () => {
    assert.equal(pickLang("https://a/auth/confirm?lang=ar", { locale: "en" }), "ar");
    assert.equal(pickLang("https://a/auth/confirm?lang=xx", { language: "en" }), "en");
    assert.equal(pickLang(undefined, { lang: "ar" }), "ar");
    assert.equal(pickLang("https://a/", { locale: "de" }), "fr");
    assert.equal(pickLang(undefined, null), "fr");
  });
});

describe("renderAuthEmail", () => {
  const types = ["signup", "invite", "magiclink", "recovery", "email_change", "email", "reauthentication", "notification"];
  it("renders every type in every language with text + html", () => {
    for (const lang of ["en", "fr", "ar"] as const)
      for (const type of types) {
        const r = renderAuthEmail({ type, lang, code: "123456", link: "https://x/y?a=1&b=2" });
        assert.ok(r.subject && r.html && r.text, `${lang}/${type}`);
        assert.ok(r.html.includes(`lang="${lang}"`));
      }
  });
  it("is RTL for Arabic only", () => {
    assert.ok(renderAuthEmail({ type: "recovery", lang: "ar" }).html.includes('dir="rtl"'));
    assert.ok(!renderAuthEmail({ type: "recovery", lang: "en" }).html.includes('dir="rtl"'));
  });
  it("shows the code and escapes the link; reauthentication has no link", () => {
    const r = renderAuthEmail({ type: "recovery", lang: "en", code: "654321", link: 'https://x/y?a=1&b="2"' });
    assert.ok(r.html.includes("654321") && r.text.includes("654321"));
    assert.ok(r.html.includes("a=1&amp;b=&quot;2&quot;"));
    const re = renderAuthEmail({ type: "reauthentication", lang: "en", code: "111222", link: "https://x" });
    assert.ok(!re.html.includes("https://x"));
  });
  it("ignores a non-numeric code", () => {
    assert.ok(!renderAuthEmail({ type: "email", lang: "en", code: "<script>" }).html.includes("<script>"));
  });
});
