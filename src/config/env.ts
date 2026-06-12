import { config } from "dotenv";
import { z } from "zod";

config();

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Sub-path the API is mounted under (e.g. "/blink" on greenpedal.net/blink).
  // Leave empty when served at a domain root. If Passenger strips the base URI,
  // keep this empty; if /blink/health 404s after deploy, set BASE_PATH=/blink.
  BASE_PATH: z
    .string()
    .default("")
    .transform((v) => (v === "/" ? "" : v.replace(/\/$/, ""))),

  // Shared secret required (as the `x-cron-secret` header) to trigger scrapes
  // via the /library/scrape endpoints. Leave empty in dev to disable the check.
  CRON_SECRET: z.string().default(""),

  // Run the in-process node-cron scheduler. Must stay OFF on cPanel/Passenger
  // (the app is spun down when idle, so in-process cron never fires) — use a
  // cPanel Cron Job hitting /library/scrape instead. Default off.
  ENABLE_INPROCESS_CRON: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const env = envSchema.parse(process.env);
