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
});

export const env = envSchema.parse(process.env);
