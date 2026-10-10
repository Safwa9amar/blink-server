// Magic-byte check: the decoded upload must start like its declared type.
const startsWith = (b: Buffer, sig: number[], offset = 0) =>
  b.length >= offset + sig.length && sig.every((v, i) => b[offset + i] === v);

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export function matchesDeclaredType(bytes: Buffer, contentType: string): boolean {
  switch (contentType) {
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8);
    case "application/pdf":
      return startsWith(bytes, ascii("%PDF-"));
    default:
      return false;
  }
}
