#!/usr/bin/env node
// One-shot deploy of blink-server to the Octenium cPanel host (Passenger),
// including a schema sync to the live Supabase DB.
//
//   node scripts/deploy.mjs            # bump patch, sync DB, build, upload, restart, verify
//   node scripts/deploy.mjs minor      # bump minor instead
//   node scripts/deploy.mjs major
//   node scripts/deploy.mjs --no-bump  # redeploy current version, no bump
//   node scripts/deploy.mjs --no-db    # skip the Supabase schema sync
//
// Auth: key-based via the `blink-host` SSH alias (see DEPLOY_OCTENIUM.md →
// "First-time setup"); Supabase via DATABASE_URL from .env (gitignored). No
// secret lives in this repo. Override targets with BLINK_SSH / BLINK_APP_ROOT /
// BLINK_URL env vars.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SSH = process.env.BLINK_SSH || "blink-host";
const APP_ROOT = process.env.BLINK_APP_ROOT || "/home/hccfdkmc/blink";
const URL = process.env.BLINK_URL || "https://blink.greenpedal.net";

const argv = process.argv.slice(2);
const skipBump = argv.includes("--no-bump");
const skipDb = argv.includes("--no-db");
const bump = argv.find((a) => ["patch", "minor", "major"].includes(a)) || (skipBump ? null : "patch");
const unknown = argv.find((a) => !["patch", "minor", "major", "--no-bump", "--no-db"].includes(a));
if (unknown) {
  console.error(`Unknown argument "${unknown}". Use patch|minor|major|--no-bump|--no-db.`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const cap = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const pkgVersion = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

// Derive a DDL-safe (session-pooler) connection string from .env DATABASE_URL.
// The runtime URL is the transaction pooler (:6543 ?pgbouncer=true), which is
// unsafe for migrations — swap to the session pooler (:5432) for `db push`.
function migrationDbUrl() {
  const envPath = join(root, ".env");
  if (!existsSync(envPath)) return null;
  const m = readFileSync(envPath, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+?)\s*$/m);
  if (!m) return null;
  return m[1]
    .replace(/^["']|["']$/g, "")
    .replace(":6543", ":5432")
    .replace(/[?&]pgbouncer=true/g, "")
    .replace(/[?&]$/, "");
}

// 1. Bump version (writes package.json + package-lock.json, no git tag)
if (bump) {
  console.log(`▸ Bumping ${bump} version…`);
  run("npm", ["version", bump, "--no-git-tag-version"]);
}
const version = pkgVersion();
console.log(`▸ Deploying blink-server v${version} → ${URL}`);

// 2. Build the single-file bundle (embeds the new version)
console.log("▸ Building…");
run("node", ["scripts/build.mjs"]);

// 3. Sync schema to the live Supabase DB BEFORE shipping code (idempotent —
//    only migrations missing from the remote history are applied). If this
//    fails we abort before touching the live app.
if (!skipDb) {
  const dbUrl = migrationDbUrl();
  if (!dbUrl) {
    console.error("⚠ No DATABASE_URL in .env — cannot sync Supabase. Pass --no-db to skip intentionally.");
    process.exit(1);
  }
  console.log("▸ Syncing schema to live Supabase (db push)…");
  run("npx", ["--no-install", "supabase", "db", "push", "--db-url", dbUrl, "--yes"]);
} else {
  console.log("▸ Skipping Supabase sync (--no-db)");
}

// 4. Back up the live file, then upload the new one
console.log("▸ Backing up remote index.js…");
run("ssh", [SSH, `cp -f ${APP_ROOT}/index.js ${APP_ROOT}/index.js.bak 2>/dev/null || true`]);
console.log("▸ Uploading dist/index.js…");
run("scp", ["dist/index.js", `${SSH}:${APP_ROOT}/index.js`]);

// 5. Trigger a Passenger graceful restart
console.log("▸ Restarting Passenger app…");
run("ssh", [SSH, `mkdir -p ${APP_ROOT}/tmp && touch ${APP_ROOT}/tmp/restart.txt`]);

// 6. Verify the live version matches what we just built
console.log("▸ Verifying…");
let live = null;
for (let i = 0; i < 6; i++) {
  try {
    const body = cap("curl", ["-s", "-m", "15", `${URL}/health`]);
    live = JSON.parse(body).version;
    if (live === version) break;
  } catch {}
  run("sleep", ["3"]);
}
if (live === version) {
  console.log(`✓ Deployed and verified: ${URL} now serving v${version}`);
} else {
  console.error(
    `⚠ Uploaded v${version} but /health reports "${live ?? "no response"}". ` +
      `Check the cPanel Node App log (${APP_ROOT}/server.log); restore with index.js.bak if needed.`
  );
  process.exit(1);
}
