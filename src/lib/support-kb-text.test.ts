import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkArticle,
  tokenizeQuery,
  buildKeywordQuery,
  buildRetrievalQuery,
  MAX_CHUNK_CHARS,
} from "./support-kb-text";

test("chunker: headings start new sections with composed titles", () => {
  const html = "<p>Intro text.</p><h2>Payouts</h2><p>Paid weekly.</p><h2>Fees</h2><p>5%.</p>";
  const c = chunkArticle({ type: "article", title: "Guide", html });
  assert.deepEqual(
    c.map((x) => x.title),
    ["Guide", "Guide › Payouts", "Guide › Fees"]
  );
  assert.equal(c[1].content, "Paid weekly.");
});

test("chunker: packs paragraphs up to the limit", () => {
  const para = "word ".repeat(100).trim(); // ~499 chars
  const html = Array.from({ length: 6 }, () => `<p>${para}</p>`).join("");
  const c = chunkArticle({ type: "article", title: "T", html });
  assert.ok(c.length >= 2);
  for (const x of c) assert.ok(x.content.length <= MAX_CHUNK_CHARS);
});

test("chunker: splits an overlong paragraph on sentences", () => {
  const sentence = "This is a sentence about delivery fees. ";
  const html = `<p>${sentence.repeat(80)}</p>`;
  const c = chunkArticle({ type: "article", title: "T", html });
  assert.ok(c.length > 1);
  for (const x of c) {
    assert.ok(x.content.length <= MAX_CHUNK_CHARS);
    assert.ok(x.content.endsWith("."));
  }
});

test("chunker: FAQ is a single chunk", () => {
  const c = chunkArticle({ type: "faq", title: "How do I pay?", html: "<p>Use <b>Blink Cash</b>.</p><p>Or card.</p>" });
  assert.deepEqual(c, [{ title: "How do I pay?", content: "Use Blink Cash. Or card." }]);
});

test("chunker: empty html and plain text", () => {
  assert.deepEqual(chunkArticle({ type: "article", title: "", html: "" }), []);
  assert.deepEqual(chunkArticle({ type: "faq", title: "Q", html: "<p> </p>" }), []);
  const c = chunkArticle({ type: "article", title: "T", html: "just plain text" });
  assert.deepEqual(c, [{ title: "T", content: "just plain text" }]);
});

test("chunker: list items and table rows", () => {
  const c = chunkArticle({
    type: "article",
    title: "T",
    html: "<ul><li>One</li><li>Two</li></ul><table><tr><td>a</td><td>b</td></tr></table>",
  });
  assert.equal(c.length, 1);
  assert.equal(c[0].content, "One\nTwo\na | b");
});

test("tokenizer: en/fr/ar, stopwords dropped, deduped", () => {
  assert.deepEqual(tokenizeQuery("How do I reset the password?"), ["reset", "password"]);
  assert.deepEqual(tokenizeQuery("Comment changer mon mot de passe"), ["changer", "mot", "passe"]);
  assert.deepEqual(tokenizeQuery("كيف أغير كلمة المرور؟"), ["أغير", "كلمة", "المرور"]);
  assert.deepEqual(tokenizeQuery("fees fees FEES"), ["fees"]);
});

test("keyword query: no tsquery-special chars survive", () => {
  const q = buildKeywordQuery("a & b | !c <-> (d:*) 'quote'; drop--table");
  assert.match(q, /^[\p{L}\p{N}]+( \| [\p{L}\p{N}]+)*$/u);
  assert.equal(buildKeywordQuery("the a of"), "");
  assert.equal(buildKeywordQuery(""), "");
});

test("buildRetrievalQuery", () => {
  const h = [
    { role: "user", content: "How do rider payouts work every week?" },
    { role: "assistant", content: "..." },
    { role: "user", content: "and fees?" },
  ];
  assert.equal(buildRetrievalQuery(h), "How do rider payouts work every week?\nand fees?");
  assert.equal(
    buildRetrievalQuery([...h.slice(0, 2), { role: "user", content: "Tell me all about the payout schedule please" }]),
    "Tell me all about the payout schedule please"
  );
  assert.equal(buildRetrievalQuery([]), "");
  assert.equal(buildRetrievalQuery([{ role: "user", content: "x ".repeat(800) }]).length, 1000);
});
