// Shared helpers/constants for the library scraper endpoints.

import { join } from "path";
import type { Context, Next } from "hono";
import { env } from "../../config/env";

export const OUTPUT_DIR = join(process.cwd(), "data", "library");

// Guards the (expensive) scrape endpoints. When CRON_SECRET is set, callers —
// e.g. the cPanel Cron Job — must send a matching `x-cron-secret` header.
// When it's empty (dev), the guard is a no-op.
export async function requireCronSecret(c: Context, next: Next) {
  if (env.CRON_SECRET && c.req.header("x-cron-secret") !== env.CRON_SECRET) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}
