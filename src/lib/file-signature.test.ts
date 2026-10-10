import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesDeclaredType } from "./file-signature";

const pad = (b: number[]) => Buffer.from([...b, 0, 0, 0, 0, 0, 0, 0, 0]);
const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP"), Buffer.from("VP8 ")]);

describe("matchesDeclaredType", () => {
  it("accepts matching signatures", () => {
    assert.equal(matchesDeclaredType(pad([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg"), true);
    assert.equal(matchesDeclaredType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png"), true);
    assert.equal(matchesDeclaredType(webp, "image/webp"), true);
    assert.equal(matchesDeclaredType(Buffer.from("%PDF-1.7\n"), "application/pdf"), true);
  });
  it("rejects mismatches", () => {
    assert.equal(matchesDeclaredType(Buffer.from("%PDF-1.7"), "image/jpeg"), false);
    assert.equal(matchesDeclaredType(pad([0xff, 0xd8, 0xff]), "image/png"), false);
    assert.equal(matchesDeclaredType(Buffer.from("RIFF1234WAVEfmt "), "image/webp"), false);
    assert.equal(matchesDeclaredType(Buffer.from("<html>"), "application/pdf"), false);
  });
  it("rejects short buffers and unknown types", () => {
    assert.equal(matchesDeclaredType(Buffer.from([0xff]), "image/jpeg"), false);
    assert.equal(matchesDeclaredType(Buffer.alloc(0), "application/pdf"), false);
    assert.equal(matchesDeclaredType(Buffer.from("%PDF-"), "text/plain"), false);
  });
});
