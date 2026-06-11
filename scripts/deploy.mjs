#!/usr/bin/env node
// One-shot deploy of blink-server to the Octenium cPanel host (Passenger).
//
//   node scripts/deploy.mjs            # bump patch, build, upload, restart, verify
//   node scripts/deploy.mjs minor      # bump minor instead
//   node scripts/deploy.mjs major
//   node scripts/deploy.mjs --no-bump  # redeploy current version, no bump
//
// Auth is key-based via the `blink-host` SSH alias (see DEPLOY_OCTENIUM.md →
// "First-time setup"). No password lives in this repo. Override the target
// with BLINK_SSH (ssh destination) and BLINK_APP_ROOT / BLINK_URL env vars.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SSH = process.env.BLINK_SSH || "blink-host";
const APP_ROOT = process.env.BLINK_APP_ROOT || "/home/hccfdkmc/blink";
const URL = process.env.BLINK_URL || "https://blink.greenpedal.net";

const arg = process.argv[2] || "patch";
const bump = ["patch", "minor", "major"].includes(arg) ? arg : null;
const skipBump = arg === "--no-bump";
if (!bump && !skipBump) {
  console.error(`Unknown argument "${arg}". Use patch|minor|major|--no-bump.`);
  process.exit(1);
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const cap = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim();
const pkgVersion = () =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

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

// 3. Back up the live file, then upload the new one
console.log("▸ Backing up remote index.js…");
run("ssh", [SSH, `cp -f ${APP_ROOT}/index.js ${APP_ROOT}/index.js.bak 2>/dev/null || true`]);
console.log("▸ Uploading dist/index.js…");
run("scp", ["dist/index.js", `${SSH}:${APP_ROOT}/index.js`]);

// 4. Trigger a Passenger graceful restart
console.log("▸ Restarting Passenger app…");
run("ssh", [SSH, `mkdir -p ${APP_ROOT}/tmp && touch ${APP_ROOT}/tmp/restart.txt`]);

// 5. Verify the live version matches what we just built
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
