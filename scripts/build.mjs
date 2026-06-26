#!/usr/bin/env node
// Build the single-file Passenger bundle, injecting the package.json version
// as __APP_VERSION__ so the running API reports the deployed version
// (GET / and GET /health). Mirrors the old `npm run build` esbuild flags.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { version } = pkg;
const esbuild = join(root, "node_modules", ".bin", "esbuild");

// The Passenger host resolves runtime deps from its own node_modules, so we keep
// EVERY package.json dependency EXTERNAL — except the ones listed here, which we
// must INLINE because they aren't installed on the host yet (a missing host dep
// otherwise crashes Passenger at startup with ERR_MODULE_NOT_FOUND). Derive the
// external list straight from package.json so a new dependency can never be
// silently bundled (esbuild can't bundle CJS deps that do dynamic require()).
const BUNDLE_INLINE = new Set(["openai"]);
const external = Object.keys(pkg.dependencies ?? {})
  .filter((dep) => !BUNDLE_INLINE.has(dep))
  .flatMap((dep) => [`--external:${dep}`, `--external:${dep}/*`]);

execFileSync(
  esbuild,
  [
    "src/index.ts",
    "--bundle",
    "--platform=node",
    "--target=node24",
    "--format=esm",
    ...external,
    `--define:__APP_VERSION__="${version}"`,
    "--outfile=dist/index.js",
  ],
  { cwd: root, stdio: "inherit" }
);

console.log(`✓ Built blink-server v${version} → dist/index.js`);
