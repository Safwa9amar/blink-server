# Deploying blink-server to Octenium (cPanel + Passenger)

Live API: **https://blink.greenpedal.net** (own subdomain, `BASE_PATH` empty) ·
Node **24** · SSH on **`162.19.98.77:5804`** (user `hccfdkmc`).

The app runs as a long-lived Node process under cPanel's **Setup Node.js App**
(Phusion Passenger). It is deployed as a **single bundled `dist/index.js`** built
with esbuild — all our source is inlined into one ESM file, `node_modules` stay
external. This avoids the plain-`tsc` trap where extensionless imports
(`./config/env`) fail at runtime under Node ESM.

---

## ⚡ Deploy in one command (the standard way)

```bash
npm run deploy            # bump PATCH → build → sync DB → upload → restart → verify
npm run deploy minor      # bump minor instead
npm run deploy major
npm run deploy -- --no-bump   # redeploy current version, no bump
npm run deploy -- --no-db     # skip the live-Supabase schema sync
```

`scripts/deploy.mjs` does the whole flow:

1. **Bumps** `package.json` `version` (so the running API reports it at `GET /`
   and `GET /health`) — patch by default; `minor` / `major` / `--no-bump`.
2. **Builds** the single-file bundle with the new version inlined.
3. **Syncs the schema to the live Supabase DB** — `supabase db push` of any
   migrations missing from the remote history (idempotent; a clean DB prints
   "Remote database is up to date"). Runs **before** the code ships so the new
   build always meets the new schema; if the push fails the deploy aborts before
   touching the live app. The DDL connection is the **session pooler** (`:5432`),
   derived from `.env`'s `DATABASE_URL` (which is the transaction pooler `:6543`,
   unsafe for migrations). Skip with `--no-db`.
4. Backs up the live `index.js` → `index.js.bak` and `scp`s the new build up.
5. Touches `tmp/restart.txt` (Passenger graceful restart).
6. Polls `https://blink.greenpedal.net/health` until the reported `version`
   matches — failing loudly if it doesn't.

**Always bump the version on deploy; that's how we tell which build is live.**
Add new schema by writing `supabase/migrations/NNNNN_*.sql` (the Drizzle-authored
SQL) before deploying — `npm run deploy` applies it to live as step 3.

Verify any time: `curl -s https://blink.greenpedal.net/health` →
`{"status":"ok","version":"X.Y.Z"}`.

### First-time setup (key-based SSH — no password in the repo)

The deploy script auths via the **`blink-host`** SSH alias using a key, so no
credentials live in git. Set it up once per machine:

```bash
# 1. dedicated deploy key
ssh-keygen -t ed25519 -N "" -C "blink-deploy" -f ~/.ssh/blink_deploy

# 2. install the public key on the server (one-time password prompt — cPanel pw)
ssh-copy-id -i ~/.ssh/blink_deploy.pub -p 5804 hccfdkmc@162.19.98.77

# 3. add the alias to ~/.ssh/config
cat >> ~/.ssh/config <<'EOF'

Host blink-host
    HostName 162.19.98.77
    Port 5804
    User hccfdkmc
    IdentityFile ~/.ssh/blink_deploy
    IdentitiesOnly yes
EOF
```

Then `ssh blink-host` should land you on the host with no password, and
`npm run deploy` works. Override the target with `BLINK_SSH`, `BLINK_APP_ROOT`,
or `BLINK_URL` env vars if it ever moves.

The sections below document the **manual** equivalent (and one-time cPanel UI
setup) that the script automates.

---

> Why not run `dist/` from plain `tsc`? tsc keeps imports like `./config/env`
> with no extension, and Node 24 ESM rejects them (`ERR_MODULE_NOT_FOUND … Did
> you mean ./config/env.js?`). The esbuild bundle resolves everything internally.
> (`server.js` + `tsx` is a still-supported alternative — see the end.)

## Why the in-process cron is OFF

Passenger spins the app **down when idle**, so `node-cron` never fires reliably.
The scheduler is gated behind `ENABLE_INPROCESS_CRON` (default `false`). Scrapes
are driven by a **cPanel Cron Job** that `curl`s `POST /library/scrape`,
protected by the `CRON_SECRET` header. Keep `ENABLE_INPROCESS_CRON=false` here.

---

## 1. Build the single file (local)

```bash
cd ~/blink-server
npm run build          # esbuild → dist/index.js (one file, ~88 KB)
```

## 2. App root layout on the server

The cPanel app root is `/home/hccfdkmc/blink`. It must contain:

```
/home/hccfdkmc/blink/
├── index.js          ← the built dist/index.js (this is the startup file)
├── package.json      ← REQUIRED: its "type":"module" makes Node treat index.js as ESM
├── package-lock.json
├── node_modules/     ← from `npm install` (external deps live here)
└── .env              ← see step 3
```

Delete any leftovers from the earlier broken deploy (the flattened `config/`,
`routes/`, `lib/` folders at the app root) — everything is now inside `index.js`.

Upload `dist/index.js` → `/home/hccfdkmc/blink/index.js` (cPanel File Manager or
`scp`), and make sure `package.json` + `package-lock.json` are there too.

> First-time only: also upload `package.json`/`package-lock.json`, then run
> `npm install` in the app root (via the venv shell, step 4) so `node_modules`
> exists. On later deploys you only re-upload `index.js`.

## 3. Env file (`/home/hccfdkmc/blink/.env`)

Generate the cron secret: `openssl rand -hex 32`.

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service-role key>   # server-only, never in the app
JWT_SECRET=<min 32 chars>
NODE_ENV=production
CRON_SECRET=<the openssl output>
BASE_PATH=
ENABLE_INPROCESS_CRON=false
```

Leave `BASE_PATH` **empty for the first deploy** — see step 5.

## 4. Setup Node.js App (cPanel UI)

cPanel → **Setup Node.js App** (create it once):

| Field | Value |
|---|---|
| Node.js version | **24** |
| Application mode | **Production** |
| Application root | `blink` |
| Application URL | `greenpedal.net/blink` |
| Application startup file | `index.js` |

Then enter the venv (the `source …activate` command cPanel shows) and:

```bash
cd ~/blink && npm install     # first deploy only
```

Click **Restart** in the panel after every upload.

## 5. Verify the base path

```bash
curl -s https://greenpedal.net/blink/health
```

- `{"status":"ok"}` → done; leave `BASE_PATH` empty (Passenger strips `/blink`
  before the app sees it).
- **404** → Passenger forwards the full path. Set `BASE_PATH=/blink` in `.env`,
  **Restart**, re-test. Then confirm a real route:

```bash
curl -s https://greenpedal.net/blink/library/sources
```

## 6. Schedule the scrapes (cPanel → Cron Jobs)

Replace `<SECRET>` with `CRON_SECRET`:

```
# Daily 3am — light scrape
0 3 * * * curl -s -X POST https://greenpedal.net/blink/library/scrape -H "x-cron-secret: <SECRET>" -H "Content-Type: application/json" -d '{"maxPages":10}' >/dev/null 2>&1

# Sundays 2am — deep scrape
0 2 * * 0 curl -s -X POST https://greenpedal.net/blink/library/scrape -H "x-cron-secret: <SECRET>" -H "Content-Type: application/json" -d '{"maxPages":25}' >/dev/null 2>&1
```

Scraped JSON lands in `~/blink/data/library` (persistent on cPanel disk).

## 7. Point the mobile app at it

Set the blink app's API base URL to `https://greenpedal.net/blink`.

---

## Updating after a code change

```bash
# local
npm run build
# upload dist/index.js → /home/hccfdkmc/blink/index.js, then Restart in cPanel
```

If dependencies changed (`package.json`), also upload it and re-run `npm install`
in the app root.

## Alternative entry: server.js + tsx (no build)

`server.js` runs the TypeScript directly via `tsx` (set it as the startup file,
upload `src/` instead of `dist/index.js`, keep `tsx` installed). Useful if you'd
rather skip the build step; the bundled `index.js` above is the leaner default.

## Troubleshooting

- **`ERR_MODULE_NOT_FOUND … Did you mean ./config/env.js?`** — you uploaded a raw
  `tsc` build, not the esbuild bundle. Run `npm run build` (esbuild) and upload
  the single `dist/index.js`.
- **`SyntaxError: Cannot use import statement outside a module`** — `package.json`
  with `"type":"module"` is missing from the app root.
- **502 / app won't boot** — check the Node App panel log / `stderr.log`. Usually
  a missing env var (the Zod schema in `src/config/env.ts` throws on boot naming
  the offending key).
- **404 on every route** — base-path mismatch; see step 5.
- **Scrape returns 401** — the cron's `x-cron-secret` header ≠ `CRON_SECRET`.
