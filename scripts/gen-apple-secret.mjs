/**
 * Generate the "Sign in with Apple" client secret — an ES256 JWT signed with
 * your .p8 key, valid up to 6 months. Paste the output into
 * SUPABASE_AUTH_EXTERNAL_APPLE_SECRET in blink-server/.env, then restart Supabase.
 *
 * Apple expires this secret (<=6 months), so re-run it periodically.
 * Zero dependencies — uses Node's built-in crypto (ES256 = ECDSA P-256 / SHA-256).
 *
 * Usage:
 *   SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID=com.astro0666.blink.signin \
 *     node scripts/gen-apple-secret.mjs [path/to/AuthKey.p8]
 *   # or: npm run apple:secret   (reads CLIENT_ID + key path from .env / default)
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── Your Apple values (from the developer portal) ─────────────────────
const TEAM_ID = "VM5A7U2YT2"; // App ID Prefix / Team ID
const KEY_ID = "BUQX8J2F75"; // the Sign in with Apple key's Key ID
// The Services ID (NOT the bundle/App ID). Required — pass via env or edit here.
const CLIENT_ID = process.env.SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID || "";
// Path to the downloaded .p8 (arg 1 wins, else this default).
const KEY_PATH =
  process.argv[2] || join(homedir(), "Downloads", `AuthKey_${KEY_ID}.p8`);

const SIX_MONTHS = 60 * 60 * 24 * 180; // Apple caps the secret at 6 months.

if (!CLIENT_ID) {
  console.error(
    "✗ Missing Services ID. Set SUPABASE_AUTH_EXTERNAL_APPLE_CLIENT_ID\n" +
      "  (e.g. com.astro0666.blink.signin) — the bundle/App ID will NOT work\n" +
      "  for the browser OAuth flow.",
  );
  process.exit(1);
}

const b64url = (input) =>
  Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const now = Math.floor(Date.now() / 1000);
const header = { alg: "ES256", kid: KEY_ID };
const payload = {
  iss: TEAM_ID,
  iat: now,
  exp: now + SIX_MONTHS,
  aud: "https://appleid.apple.com",
  sub: CLIENT_ID,
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;

let privateKey;
try {
  privateKey = readFileSync(KEY_PATH, "utf8");
} catch {
  console.error(`✗ Could not read key at ${KEY_PATH}`);
  process.exit(1);
}

// dsaEncoding 'ieee-p1363' → raw r||s signature (JWS format), not DER.
const signature = createSign("SHA256")
  .update(signingInput)
  .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });

const jwt = `${signingInput}.${b64url(signature)}`;

console.error(
  `✓ Apple client secret for ${CLIENT_ID}\n` +
    `  expires ${new Date((now + SIX_MONTHS) * 1000).toISOString().slice(0, 10)} — regenerate before then.\n`,
);
console.log(jwt);
