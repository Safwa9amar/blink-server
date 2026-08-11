# Customer Email Inbox — ops runbook

Adds a staff-facing email inbox: inbound customer mail is pulled from an IMAP
mailbox into `email_threads` / `email_messages`, and staff reply over SMTP from
the dashboard (`/email`). All transport lives here in blink-server (secrets +
Nodemailer can't run in the browser); the dashboard proxies to the staff-gated
`/email/*` routes and subscribes to Supabase Realtime for live updates.

## What shipped

- **Schema:** `src/db/schema/email-threads.ts`, `email-messages.ts` (registered in
  `src/db/schema/index.ts` + `src/db/index.ts`).
- **Migration:** `supabase/migrations/00031_email_inbox.sql` (two tables, deny-all
  RLS = staff-only select, Realtime publication + `REPLICA IDENTITY FULL`).
- **Transport:** `src/lib/email/imap.ts` (`pollEmailInbox()`), `smtp.ts`
  (`sendEmailReply()`), `shared.ts` (threading/columns helpers). Deps:
  `nodemailer`, `imapflow`, `mailparser`.
- **Routes:** `src/routes/email/*` → `GET /email/threads`, `GET /email/threads/:id`,
  `POST /email/threads/:id/{reply,assign,resolve,read}` (all `auth` + `requireStaff`).
- **Cron:** `POST /cron/email-poll` (guarded by `x-cron-secret`).
- **Env:** `SMTP_*` / `IMAP_*` in `src/config/env.ts` + `.env.example`.

## Deploy checklist

1. **Install deps on the server app root** (esbuild keeps `node_modules` external,
   so the new packages must physically exist on the host):
   ```
   cd /home/hccfdkmc/blink && npm install nodemailer imapflow mailparser
   ```
2. **Set the mailbox secrets** in the server `.env` (point at the cPanel mailbox
   that receives customer mail, e.g. `support@blink.dz`):
   ```
   SMTP_HOST=mail.blink.dz
   SMTP_PORT=587            # 465 if SMTP_SECURE=true
   SMTP_SECURE=false        # false = STARTTLS on 587; true = TLS on 465
   SMTP_USER=support@blink.dz
   SMTP_PASS=•••
   SMTP_FROM="Blink Support <support@blink.dz>"   # optional; defaults to SMTP_USER
   IMAP_HOST=mail.blink.dz
   IMAP_PORT=993
   IMAP_SECURE=true
   IMAP_USER=support@blink.dz
   IMAP_PASS=•••
   IMAP_MAILBOX=INBOX
   ```
   All are optional — with them unset the poll cron reports `"IMAP not configured"`
   and the reply route returns `503 "Email is not configured"` (nothing throws).
3. **Apply the migration** (session pooler, same as every migration):
   ```
   npm run db:push          # or: npx supabase db push --db-url <session-pooler> --yes
   ```
4. **Deploy the bundle:** `npm run deploy`.
5. **Add the cPanel Cron Job** (poll every 2 minutes):
   ```
   */2 * * * * curl -sS -X POST https://blink.greenpedal.net/cron/email-poll -H "x-cron-secret: $CRON_SECRET" >/dev/null 2>&1
   ```
6. **Dashboard:** deploy blink-dashboard (Vercel). The `/email` route appears in the
   sidebar for `super_admin` + `support_admin`. It calls these routes via
   `BLINK_API_BASE_URL` (defaults to `https://blink.greenpedal.net`).

## Notes / behavior

- **Idempotency:** each RFC `Message-ID` is stored once (unique partial index) and
  every processed IMAP message is flagged `\Seen`, so overlapping polls are safe.
- **Threading:** inbound mail joins an existing thread by `In-Reply-To`/`References`
  → stored Message-ID, else by `customer_email` + normalized subject; otherwise a
  new thread is created. Replies set `In-Reply-To`/`References` so they land in the
  customer's existing email thread. A reply/inbound to a `closed` thread reopens it.
- **User linkage:** `email_threads.user_id` is set when `customer_email` matches a
  `users.email` (case-insensitive); strangers are stored by address only.
- **Not verified end-to-end here:** real send/receive needs the live mailbox
  credentials + the migration applied. Smoke test after deploy: send an email to
  the mailbox, wait for the next poll, confirm the thread appears at `/email`, then
  reply and confirm the customer receives it.
