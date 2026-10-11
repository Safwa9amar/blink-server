import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { storeDocumentCopy, storeDocumentName } from "./store-document-copy";
import { STORE_DOC_KEYS } from "./store-documents";

const LANGS = ["en", "fr", "ar"] as const;

describe("storeDocumentName", () => {
  it("names every document in every language", () => {
    for (const key of STORE_DOC_KEYS) {
      for (const lang of LANGS) assert.ok(storeDocumentName(key, lang).trim(), `${key}/${lang}`);
    }
    assert.equal(storeDocumentName("commercial_register_front", "en"), "Commercial register (front)");
  });
});

describe("storeDocumentCopy", () => {
  it("names the rejected document, the store and the reason", () => {
    const copy = storeDocumentCopy({
      kind: "store_document_rejected",
      name: "Chez Amine",
      document: "commercial_register_back",
      reason: "  Blurry scan ",
    });
    assert.equal(copy.kind, "store_document_rejected");
    assert.equal(copy.en.title, "Document rejected");
    assert.equal(
      copy.en.description,
      "Commercial register (back) of Chez Amine was rejected: Blurry scan. Please upload a new one."
    );
    for (const lang of LANGS) {
      assert.ok(copy[lang].title.trim(), `${lang} title`);
      assert.ok(copy[lang].description.includes("Chez Amine"), `${lang} store`);
      assert.ok(copy[lang].description.includes("Blurry scan"), `${lang} reason`);
      assert.ok(copy[lang].description.includes(storeDocumentName("commercial_register_back", lang)), `${lang} doc`);
      assert.ok(!copy[lang].description.includes("  Blurry"), `${lang} trimmed`);
    }
  });

  it("asks to correct a number rather than upload a file", () => {
    const copy = storeDocumentCopy({ kind: "store_document_rejected", name: "S", document: "nif", reason: "Wrong" });
    assert.match(copy.en.description, /correct it/);
    assert.doesNotMatch(copy.en.description, /upload/i);
  });

  it("leaks nothing without a reason", () => {
    for (const reason of [undefined, null, "", "  "]) {
      const copy = storeDocumentCopy({ kind: "store_document_rejected", name: "S", document: "nis", reason });
      for (const lang of LANGS) {
        assert.doesNotMatch(copy[lang].description, /undefined|null|: \./, `${lang}`);
      }
    }
  });

  it("announces that every document is verified", () => {
    const copy = storeDocumentCopy({ kind: "store_documents_verified", name: "Chez Amine", document: "nis" });
    assert.equal(copy.kind, "store_documents_verified");
    assert.equal(copy.en.title, "Documents verified");
    for (const lang of LANGS) {
      assert.ok(copy[lang].title.trim(), `${lang} title`);
      assert.ok(copy[lang].description.includes("Chez Amine"), `${lang} store`);
    }
  });
});
