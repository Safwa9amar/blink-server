// Same injection as src/app.ts (scripts/build.mjs --define). Duplicated so
// tools don't import app.ts (which imports the /mcp router → cycle).
declare const __APP_VERSION__: string | undefined;
export const VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
