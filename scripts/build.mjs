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

execFileSync(
  esbuild,
  [
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=esm",
    "--packages=external",
    `--define:__APP_VERSION__="${version}"`,
    "--outfile=dist/index.js",
  ],
  { cwd: root, stdio: "inherit" }
);

console.log(`✓ Built blink-server v${version} → dist/index.js`);
