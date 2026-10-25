# Payment gateways (Chargily, Stripe, SATIM) — design

Date: 2026-10-20 · Repos: blink-server (owner), blink (mobile), blink-dashboard

## Scope

Online card payment for two money flows that today have no provider behind them:

1. **Rider wallet top-up** — a Blink Cash deposit paid by card. Today `method=electronic` is a
   manual bank transfer reviewed by finance (`status=review`); agent deposits are QR + PIN.
   Both stay. A new method **`online`** is added.
2. **Agent & merchant dues** — `POST /agents/dues/pay`, `POST /merchant/dues/pay` insert a
   `pending` row that nothing ever completes. When the chosen method is a gateway method, the
   row is completed by the gateway instead.

Out of scope: customer order checkout (stays cash on delivery), withdrawals/payouts (no
gateway pays out), refunds through the gateway (finance reverses in Blink Cash as today).

## Providers

| Provider | Methods | Status | Confirmation |
|---|---|---|---|
| `chargily` — Chargily Pay v2 | `edahabia`, `cib` | primary, DZD | webhook (HMAC) + provider re-fetch |
| `stripe` — Stripe Checkout Sessions | `card` (international Visa/Mastercard) | optional | webhook (signed) + provider re-fetch |
| `satim` — SATIM CIB direct (RBS REST) | `cib` | **disabled stub** until a bank issues credentials | no webhook: confirm on return + status poll |

A provider is **enabled iff its env is set**. Method → provider routing:
`edahabia → chargily`, `cib → satim` when `PAYMENT_CIB_PROVIDER=satim` and SATIM is configured,
else `chargily`, `card → stripe`.

### Env (blink-server, all optional — the server boots without them)

```
PUBLIC_API_URL=https://blink.greenpedal.net   # base for webhook + return URLs
APP_RETURN_URL=blink://payments/return        # deep link the return page redirects to
CHARGILY_SECRET_KEY=                           # test_sk_… / live_sk_…
CHARGILY_MODE=test                             # test | live → pay.chargily.net/test/api/v2 | /api/v2
STRIPE_SECRET_KEY=                             # sk_test_… / sk_live_…
STRIPE_WEBHOOK_SECRET=                         # whsec_…
STRIPE_CURRENCY=dzd
SATIM_USERNAME=
SATIM_PASSWORD=
SATIM_TERMINAL_ID=
SATIM_MODE=test                                # test.satim.dz | cib.satim.dz
PAYMENT_CIB_PROVIDER=chargily                  # chargily | satim
PAYMENT_CHECKOUT_TTL_MINUTES=60
```

Mode (test/live) is derived from the key prefix where possible and reported to clients so the
app can show a "Test mode" badge.

## Data model (hand-written supabase migration + Drizzle schema; Drizzle is the source of truth)

- `alter type deposit_method add value 'online'`
- enums `payment_provider` (chargily, stripe, satim), `payment_status` (pending, paid, failed,
  canceled, expired), `payment_purpose` (wallet_topup, agent_dues, merchant_dues)
- **`payments`**: `id uuid pk`, `user_id → users`, `purpose`, `ref_id uuid` (transactions.id /
  agent_dues_payments.id / merchant_dues_payments.id), `provider`, `method text`, `amount
  numeric(10,2)` (what the card is charged), `currency text default 'DZD'`, `status`,
  `provider_ref text` (checkout / session / order id), `checkout_url text`, `livemode bool`,
  `failure_reason text`, `paid_at`, `expires_at`, `last_synced_at`, `metadata jsonb`, timestamps.
  Unique `(provider, provider_ref)`, index `(purpose, ref_id)`, index `(status, expires_at)`.
  RLS on; select own (`auth.uid() = user_id`); writes service role only.
- **`payment_events`**: `id`, `provider`, `event_id text`, `type text`, `payment_id → payments`
  (nullable), `payload jsonb`, `received_at`. Unique `(provider, event_id)` = webhook idempotency.
  RLS on, no policies (service role only).
- SQL **`blink_cash_gateway_complete(p_txn uuid, p_reference text)`** (security definer): lock
  the txn; `not_found` if missing; return it unchanged if already `completed` (idempotent);
  `not_pending` unless `method = 'online'` and status in (`pending`, `cancelled`) — a payment
  that arrives after the request lapsed is still credited; set `completed`, `completed_at`,
  `reference`, clear cancel fields; `perform blink_cash_settle(p_txn)`.
- Online deposits are created with `expires_at = null` so `blink_cash_expire_pending` never
  touches them; the payments module owns their lifecycle.

## Money rules

- Wallet top-up charges `transactions.total` (amount + Blink fee); the wallet is credited
  `amount` by `blink_cash_settle` (existing behaviour).
- Dues charge the same total the app shows on the pay summary (amount + `fees` where the app
  shows it).
- The gateway's own fee is absorbed by Blink (Chargily `chargily_pay_fees_allocation=merchant`).
- **Fulfil only on an exact match** of provider-reported amount and currency against
  `payments.amount` / `currency`. A mismatch leaves the payment `pending`, sets
  `failure_reason='amount_mismatch'` and raises a staff alert. Never settle on the return URL
  alone (except SATIM, whose confirm call is server-to-server).
- Fulfilment is idempotent end to end: `payment_events` unique key, `payments.status` guard
  (`update … where status='pending'`), and `blink_cash_gateway_complete` / dues `where
  status='pending'`.
- Fulfilment by purpose: `wallet_topup` → rpc `blink_cash_gateway_complete(ref_id,
  provider_ref)`; `agent_dues` / `merchant_dues` → mark the dues row `completed` (plus
  reference / completed_at if those columns exist).
- Failure / cancel / expiry → payment `failed|canceled|expired`; the deposit is cancelled
  (`blink_cash_cancel`, reason `expired` or `rider`); the dues row is cancelled (or left as is if
  the table has no cancelled status — note which).

## API (tag `payments`; staff routes tag `admin-payments` so orval skips them)

OpenAPI routes:

- `GET /payments/methods` (any signed-in role) →
  `{ methods: [{ id: "edahabia"|"cib"|"card", provider, label, test_mode: boolean }] }` — only
  enabled providers. Empty list = no online payment.
- `GET /payments/{id}` (owner) → `{ payment: Payment }`. If still `pending` and not synced in the
  last 10 s, the server re-fetches the provider status first (so the flow works without
  webhooks, e.g. local dev, and for SATIM).
- `POST /payments/{id}/cancel` (owner, only while `pending`) → cancels at the provider when it
  supports it (Stripe `sessions.expire`), marks `canceled`, cancels the deposit / dues row.
- `POST /transactions/deposit` — `method` gains `"online"`; new `payment_method:
  "edahabia"|"cib"|"card"` (required when online); `locale?: "ar"|"fr"|"en"`. Response
  `TransactionResponse` gains `checkout: PaymentCheckout | null`. A `client_ref` replay of an
  online deposit returns the same checkout while pending.
- `POST /agents/dues/pay`, `POST /merchant/dues/pay` — when `method` is a gateway method id the
  row is created `pending` with a payment and the response gains `checkout`. Other method ids
  keep today's manual pending behaviour. PIN stays required.
- Staff: `GET /payments/admin` (filters status/provider/purpose/user, paginated),
  `GET /payments/admin/providers` (per provider: configured, test_mode, methods, webhook_url),
  `POST /payments/admin/{id}/sync`. Role `finance_admin` (super_admin passes).

Schemas:

```
PaymentCheckout = { payment_id: uuid, provider, method, checkout_url, return_url, expires_at }
Payment = { id, purpose, ref_id, provider, method, amount, currency, status, failure_reason,
            paid_at, expires_at, created_at, checkout_url (only while pending), test_mode }
```

Plain Hono routes (not in OpenAPI, no auth, raw body):

- `POST /payments/webhooks/chargily` — verify header `signature` = hex HMAC-SHA256(raw body,
  CHARGILY_SECRET_KEY) with timingSafeEqual; then re-fetch the checkout from Chargily; act on
  `checkout.paid` / `checkout.failed` / `checkout.canceled` / expired. Always 200 once verified
  and stored (even for unknown checkouts); 400/401 only for a bad signature.
- `POST /payments/webhooks/stripe` — `stripe.webhooks.constructEvent(raw, sig, secret)`;
  `checkout.session.completed` (payment_status=paid) and `async_payment_succeeded` → paid;
  `async_payment_failed` → failed; `checkout.session.expired` → expired.
- `GET /payments/return/{id}?outcome=success|failure` — public; 302 to
  `${APP_RETURN_URL}?payment_id={id}&outcome=…` with a minimal trilingual HTML fallback ("Return
  to Blink" link). Reveals nothing else. For SATIM it first confirms the order server-to-server.

Provider return URLs: `success_url` / `failure_url` (Chargily), `success_url` / `cancel_url`
(Stripe), `returnUrl` / `failUrl` (SATIM) all point at `/payments/return/{id}`.

Expiry: a lazy sweep (on `GET /payments/{id}` and `POST /cron/…` if a cron route pattern exists)
marks payments past `expires_at` with no paid status as `expired`, after one last provider check.

## Mobile (blink)

- `hooks/use-payment-methods.ts` wraps the generated `GET /payments/methods` hook.
- One shared checkout runner: `WebBrowser.openAuthSessionAsync(checkout_url, "blink://payments/return")`,
  then route to the role's **payment status** screen, which polls `GET /payments/{id}` (2 s,
  focused only, ~3 min cap), shows pending / success / failed / expired, offers retry or cancel,
  and on success continues to the existing summary (rider `deposit-summary`, agent/merchant
  `pay-summary`). Dismissing the browser never cancels: the user may have paid.
- The `blink://payments/return` deep link must not land on an unmatched route (cold start too):
  route it to the signed-in role's status screen.
- Rider: the deposit method sheet offers **Pay online** when methods exist; the provider sheet
  lists the server methods (EDAHABIA, CIB, Visa/Mastercard) instead of the hardcoded
  Dahabia/Charjily/Stripe/Satim list; "Test mode" badge when `test_mode`.
- Agent / merchant dues: the method sheet lists gateway methods first, then the manual
  `settings.dues_payment_methods`; after PIN, a response with `checkout` runs the checkout.
- All copy in en/ar/fr/ch; RTL, theme-token, nav-helper and selector rules from CLAUDE.md.

## Dashboard (blink-dashboard)

Blink Cash → **Payments** tab: provider cards (configured, test/live, methods, webhook URL with
copy), and a payments table (status, provider, method, purpose, user, amount, created, paid,
failure reason) with filters and a **Re-check** action (`POST /payments/admin/{id}/sync`).
Read-only otherwise. Follows the dashboard's i18n triad and finance_admin gating.
