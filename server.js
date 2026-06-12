// cPanel / Phusion Passenger entrypoint.
//
// We run the TypeScript app directly through tsx instead of a compiled build:
//   * the `tsc` build hits a baseline `ws` realtime typing error, and
//   * tsc's bundler-mode output keeps extensionless relative imports
//     (e.g. "./routes/auth") that Node's ESM loader can't resolve at runtime.
// tsx strips types and resolves those imports on load, so `node server.js`
// boots the real server. Passenger hijacks the listen() call from
// @hono/node-server, so the PORT we pass is overridden by Passenger.
import { register } from "tsx/esm/api";

register();
// Top-level await so Passenger's startup file finishes loading the app (and
// thus the listen() call it hooks) before it considers the boot complete.
await import("./src/index.ts");
