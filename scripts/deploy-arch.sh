#!/bin/sh
# npm run deploy:arch — DEV ONLY. Ship this working copy (uncommitted changes
# included) to the LAN box `arch` and (re)start the API container there.
# See deploy/arch/docker-compose.yml. Needs the `arch` ssh alias (~/.ssh/config).
set -eu
cd "$(dirname "$0")/.."

HOST="${ARCH_SSH:-arch}"

# arch has no rsync (installing needs sudo), so stream a tarball and swap the
# directory, which also drops files deleted locally.
COPYFILE_DISABLE=1 tar -czf - --no-mac-metadata --no-xattrs --no-fflags \
  --exclude ./node_modules --exclude ./dist --exclude ./.git \
  --exclude './.env' --exclude './.env.*' --exclude '*.p8' --exclude '*.log' . |
  ssh "$HOST" 'set -e; rm -rf ~/blink-server.new; mkdir ~/blink-server.new
    tar -xzf - -C ~/blink-server.new
    rm -rf ~/blink-server.old; [ -d ~/blink-server ] && mv ~/blink-server ~/blink-server.old
    mv ~/blink-server.new ~/blink-server; rm -rf ~/blink-server.old'

ssh "$HOST" 'set -e
  test -f ~/blink-server-env/api.env || { echo "missing ~/blink-server-env/api.env on arch" >&2; exit 1; }
  cd ~/blink-server/deploy/arch
  docker compose up -d --build
  for i in $(seq 1 30); do
    curl -fsS http://localhost:3001/health && echo && exit 0
    sleep 2
  done
  echo "API did not become healthy:" >&2; docker compose logs --tail 40 api >&2; exit 1'
