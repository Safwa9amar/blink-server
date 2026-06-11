# Supabase Guide — Blink Server

## Prerequisites

- **Docker Desktop** — required for local Supabase
- **Supabase CLI** — `brew install supabase/tap/supabase`
- **Node.js 20+** — runtime

---

## Local Development

### Start local Supabase

```bash
supabase start
```

This spins up all services via Docker:

| Service        | URL                                                           |
| -------------- | ------------------------------------------------------------- |
| API            | http://127.0.0.1:54321                                        |
| Studio (GUI)   | http://127.0.0.1:54323                                        |
| Database       | postgresql://postgres:postgres@127.0.0.1:54322/postgres       |
| Mailpit (mail) | http://127.0.0.1:54324                                        |

### Stop local Supabase

```bash
supabase stop           # stop containers (keeps data)
supabase stop --no-backup  # stop and wipe all data
```

### Check status

```bash
supabase status         # shows URLs, keys, and running services
```

### Local .env

After `supabase start`, update your `.env` with the printed keys:

```env
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_ANON_KEY=<publishable key from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<secret key from supabase status>
```

### Start the API server

```bash
npm run dev             # runs on http://localhost:3000
```

---

## Cloud (Production)

### Project

- **URL:** https://yrgomuepseaktvbsepre.supabase.co
- **Dashboard:** https://supabase.com/dashboard/project/yrgomuepseaktvbsepre

### Login

```bash
supabase login          # opens browser for auth
```

### Link to cloud project

```bash
supabase link --project-ref yrgomuepseaktvbsepre
```

### Cloud .env

Get your keys from the dashboard → Settings → API:

```env
SUPABASE_URL=https://yrgomuepseaktvbsepre.supabase.co
SUPABASE_ANON_KEY=<anon key from dashboard>
SUPABASE_SERVICE_ROLE_KEY=<service_role key from dashboard>
```

---

## Migrations

Migrations live in `supabase/migrations/`. They are the single source of truth for the database schema.

### Create a new migration

```bash
supabase migration new <name>
# Example:
supabase migration new add_wallets_table
```

This creates `supabase/migrations/<timestamp>_add_wallets_table.sql`. Edit the SQL file.

### Apply migrations locally

```bash
supabase db reset       # drops and recreates DB, runs all migrations from scratch
```

### Push migrations to cloud

```bash
supabase db push        # applies only NEW migrations that haven't run yet
```

### Pull schema from cloud (if you made changes in the dashboard)

```bash
supabase db pull        # generates a migration file from remote changes
```

### View migration status

```bash
supabase migration list # shows which migrations have been applied locally and remotely
```

---

## Generate TypeScript Types

After any schema change, regenerate types:

```bash
# From local database
npm run db:types
# This runs: supabase gen types typescript --local > src/types/supabase.ts

# From cloud database
supabase gen types typescript --project-id yrgomuepseaktvbsepre > src/types/supabase.ts
```

Then update `src/lib/supabase.ts` to import the generated types:

```ts
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../types/supabase";

export const supabase = createClient<Database>(url, key);
```

---

## Database Schema

### Tables

| Table              | Description                              |
| ------------------ | ---------------------------------------- |
| `users`            | All users (customer, rider, agent, merchant) |
| `rider_profiles`   | Rider-specific data (wilaya, bank RIB)   |
| `vehicles`         | Rider vehicles and document statuses     |
| `trips`            | Ride trips with pickup/dropoff           |
| `transactions`     | Deposits and withdrawals (rider + agent) |
| `agent_shops`      | Agent shop profiles and locations        |
| `orders`           | Customer marketplace orders              |
| `notifications`    | Push notifications per user              |
| `addresses`        | Customer saved addresses                 |

### Row Level Security (RLS)

All tables have RLS enabled. Key policies:

- **users** — can only read/update own row
- **trips** — rider and customer can see their own trips
- **transactions** — user and processing agent can see
- **agent_shops** — public read (for locator), owner can update
- **orders** — customer and assigned rider can see
- **notifications** — own notifications only
- **addresses** — own addresses only

> The server uses `supabaseAdmin` (service role key) which **bypasses RLS**. The anon key respects RLS — use it for client-side calls.

---

## Common Workflows

### Full reset (local)

```bash
supabase db reset       # wipe + rerun all migrations
npm run dev             # restart server
```

### Add a new table

```bash
supabase migration new create_wallets_table
# Edit supabase/migrations/<timestamp>_create_wallets_table.sql
supabase db reset       # test locally
npm run db:types        # regenerate types
supabase db push        # deploy to cloud
```

### Modify an existing table

```bash
supabase migration new add_balance_to_users
# Edit the migration:
#   ALTER TABLE users ADD COLUMN balance NUMERIC(10,2) DEFAULT 0;
supabase db reset       # test locally
npm run db:types        # regenerate types
supabase db push        # deploy to cloud
```

### Seed data (local only)

Create `supabase/seed.sql` with INSERT statements. It runs automatically on `supabase db reset`.

```sql
-- supabase/seed.sql
INSERT INTO users (id, phone_number, role, first_name, last_name)
VALUES
  ('00000000-0000-0000-0000-000000000001', '+213555000001', 'rider', 'Ahmed', 'Benali'),
  ('00000000-0000-0000-0000-000000000002', '+213555000002', 'agent', 'Karim', 'Saidi'),
  ('00000000-0000-0000-0000-000000000003', '+213555000003', 'customer', 'Sara', 'Mehdaoui');
```

### Switch between local and cloud

Just change your `.env`:

```bash
# Local
SUPABASE_URL=http://127.0.0.1:54321

# Cloud
SUPABASE_URL=https://yrgomuepseaktvbsepre.supabase.co
```

---

## Troubleshooting

| Problem                          | Solution                                          |
| -------------------------------- | ------------------------------------------------- |
| `supabase start` hangs           | Make sure Docker Desktop is running               |
| Port 54321 already in use        | `supabase stop` then `supabase start`             |
| Migration fails on push          | Fix the SQL, then `supabase db push` again        |
| Types out of date                | Run `npm run db:types`                            |
| WebSocket error (Node 20)        | `ws` package is installed — check `src/lib/supabase.ts` |
| RLS blocking queries             | Use `supabaseAdmin` for server ops, not `supabase` |
| Config parse error                | Run `supabase init --force` to regenerate config  |
