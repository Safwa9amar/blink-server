#!/usr/bin/env node
// Build the single-file Passenger bundle, injecting the package.json version
// as __APP_VERSION__ so the running API reports the deployed version
// (GET / and GET /health). Mirrors the old `npm run build` esbuild flags.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const esbuild = join(root, "node_modules", ".bin", "esbuild");

// The Passenger host installs runtime deps in its own node_modules, so we keep
// them EXTERNAL (resolved at runtime) rather than bundling — except `openai`,
// which is intentionally BUNDLED so a new dependency can't break startup with
// ERR_MODULE_NOT_FOUND when it isn't yet installed on the host. (Everything
// below is already present in the host node_modules.)
const HOST_EXTERNAL = [
  "@hono/node-server",
  "hono",
  "hono/*",
  "@supabase/supabase-js",
  "cheerio",
  "dotenv",
  "drizzle-orm",
  "drizzle-orm/*",
  "node-cron",
  "ws",
  "zod",
];

execFileSync(
  esbuild,
  [
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=esm",
    ...HOST_EXTERNAL.map((p) => `--external:${p}`),
    `--define:__APP_VERSION__="${version}"`,
    "--outfile=dist/index.js",
  ],
  { cwd: root, stdio: "inherit" }
);

console.log(`✓ Built blink-server v${version} → dist/index.js`);
