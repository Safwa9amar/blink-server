import { config } from "dotenv";
import { z } from "zod";

config();

// Supabase keys go into request headers. A key pasted into a hosting dashboard
// together with the lines under it (Render primary, 2026-10-11) made every
// header invalid, and the error echoed the whole value, other secrets included.
// Keys never contain whitespace, so keep only the first token.
const supabaseKey = z
  .string()
  .trim()
  .min(1)
  .transform((v) => v.split(/\s+/)[0]);

// An empty value in .env (KEY=) means "unset" for the optional settings below.
const blankToUndefined = (v: unknown) => (v === "" ? undefined : v);

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: supabaseKey,
  SUPABASE_SERVICE_ROLE_KEY: supabaseKey,
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

  // Secret for the opaque rider tokens on the request maps (nearby_riders_map
  // on POST /ride/quote and /courier/quote; src/lib/nearby-riders-map.ts).
  // Empty = a hard-coded dev salt. Set a random value in production
  // (openssl rand -hex 32) so tokens can't be linked back to rider ids.
  RIDER_MAP_SALT: z.string().default(""),

  // AI bot (support live chat). OpenRouter is the default provider; the key is
  // optional so the server still boots without it (the bot then escalates).
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(), // e.g. "google/gemini-2.5-flash"
  DEFAULT_AI_PROVIDER: z.enum(["openrouter", "ollama", "lmstudio"]).default("openrouter"),

  // Run the in-process node-cron scheduler. Must stay OFF on cPanel/Passenger
  // (the app is spun down when idle, so in-process cron never fires) — use a
  // cPanel Cron Job hitting /library/scrape instead. Default off.
  ENABLE_INPROCESS_CRON: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // ─── Customer email inbox (SMTP send + IMAP intake) ──────────────────
  // All optional so the server still boots without email configured — the
  // inbox then degrades gracefully: POST /cron/email-poll reports "disabled"
  // and the reply route returns an error instead of throwing. Point these at
  // the cPanel mailbox (e.g. support@blink.dz). SECURE=true means TLS on
  // connect (SMTP 465 / IMAP 993); false uses STARTTLS (SMTP 587).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_SECURE: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  // From address on outbound replies. Defaults to SMTP_USER when unset.
  SMTP_FROM: z.string().optional(),

  IMAP_HOST: z.string().optional(),
  IMAP_PORT: z.coerce.number().default(993),
  IMAP_SECURE: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  IMAP_USER: z.string().optional(),
  IMAP_PASS: z.string().optional(),
  // Mailbox to poll for new customer mail.
  IMAP_MAILBOX: z.string().default("INBOX"),

  // ─── OTP SMS (Supabase Send SMS hook → SMS Gate Android app) ─────────
  // Secret Supabase generates when the Send SMS hook is created
  // ("v1,whsec_…"). Empty = POST /hooks/send-sms rejects every call.
  SEND_SMS_HOOK_SECRET: z.string().default(""),
  // Same for the Send Email hook ("v1,whsec_…"). Empty = POST /hooks/send-email
  // rejects every call. Once enabled, ALL Supabase auth emails go through it.
  SEND_EMAIL_HOOK_SECRET: z.string().default(""),
  // SMS Gate API base. Default is the public cloud relay; in the app's Local
  // server mode use http://<phone-lan-ip>:8080 instead.
  SMS_GATE_URL: z
    .string()
    .url()
    .default("https://api.sms-gate.app/3rdparty/v1")
    .transform((v) => v.replace(/\/$/, "")),
  // Basic-auth pair shown in the app (Settings → Cloud server). Unset in dev =
  // the hook just logs the OTP to the console.
  SMS_GATE_USERNAME: z.string().optional(),
  SMS_GATE_PASSWORD: z.string().optional(),
  // Which SIM slot sends (1-based). Unset = the phone's default SMS SIM. Pin it
  // on dual-SIM phones where only one line can send SMS.
  SMS_GATE_SIM_NUMBER: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(3).optional()
  ),
  // Most phone numbers one notification may text (the dashboard's SMS channel).
  // Every SMS leaves from the gateway phone's SIM, so a broadcast over this is
  // refused before anything is sent.
  SMS_BROADCAST_MAX: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).default(500)
  ),

  // ─── Online payment gateways (src/lib/payments) ──────────────────────
  // All optional: a provider is enabled only when its keys are set, and the
  // server boots without any. Spec: docs/superpowers/specs/2026-10-20-payment-gateways-design.md
  // Public base of this API (webhook + return URLs the providers call back).
  PUBLIC_API_URL: z.string().default("").transform((v) => v.trim().replace(/\/$/, "")),
  // Deep link the /payments/return page redirects to.
  APP_RETURN_URL: z.preprocess(blankToUndefined, z.string().trim().default("blink://payments/return")),
  CHARGILY_SECRET_KEY: z.string().trim().optional(),
  CHARGILY_MODE: z.preprocess(blankToUndefined, z.enum(["test", "live"]).default("test")),
  STRIPE_SECRET_KEY: z.string().trim().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().trim().optional(),
  // Stripe charges euros: the dinar total is converted at STRIPE_DZD_RATE (DZD
  // for 1 €), a fixed rate Blink sets. Stripe stays off until the rate is set.
  STRIPE_CURRENCY: z.preprocess(
    (v) => blankToUndefined(typeof v === "string" ? v.trim().toLowerCase() : v),
    z.enum(["eur", "dzd"]).default("eur")
  ),
  STRIPE_DZD_RATE: z.preprocess(blankToUndefined, z.coerce.number().positive().optional()),
  SATIM_USERNAME: z.string().trim().optional(),
  SATIM_PASSWORD: z.string().optional(),
  SATIM_TERMINAL_ID: z.string().trim().optional(),
  SATIM_MODE: z.preprocess(blankToUndefined, z.enum(["test", "live"]).default("test")),
  PAYMENT_CIB_PROVIDER: z.preprocess(blankToUndefined, z.enum(["chargily", "satim"]).default("chargily")),
  // Comma-separated user ids allowed to pay through a TEST-mode provider in
  // production (test cards would otherwise credit real wallets). Ignored outside production.
  PAYMENTS_TEST_USER_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  PAYMENT_CHECKOUT_TTL_MINUTES: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(5).max(1440).default(60)
  ),
});

export const env = envSchema.parse(process.env);
