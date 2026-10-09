#!/bin/sh
# npm run sync:arch — DEV ONLY. Two-way row sync between arch's Supabase and the
# online dev project, run from this Mac (see deploy/arch/sync/sync.mjs). The
# database URLs are the session-pooler DIRECT_URLs already in .env (online) and
# .env.arch.local (arch); they aren't copied anywhere.
#   npm run sync:arch -- bootstrap --wipe-arch   # once: arch := online, start capture
#   npm run sync:arch                            # keep both in sync (Ctrl+C stops)
set -eu
cd "$(dirname "$0")/.."
url() { grep -E '^DIRECT_URL=' "$1" | head -1 | cut -d= -f2-; }
ARCH_DB_URL="$(url .env.arch.local)" CLOUD_DB_URL="$(url .env)" exec node deploy/arch/sync/sync.mjs "$@"
