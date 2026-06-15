#!/usr/bin/env bash
# One-shot setup for the Blink API on a fresh Oracle Cloud "Always Free"
# Ubuntu ARM (Ampere A1) VM. Idempotent — safe to re-run.
#
# Run AS the `ubuntu` user (it uses sudo where needed):
#   curl -fsSL <raw-url>/setup.sh | bash          # or copy & run
# Prereqs you do by hand first (see DEPLOY_ORACLE.md):
#   1. Instance created, you can SSH in as ubuntu.
#   2. Repo present at ~/blink-server (git clone or scp).
#   3. ~/blink-server/.env created with all secrets (PORT=3001).
#   4. A DNS record -> this VM's IP, and ports 80/443 open in the OCI
#      security list (this script opens the OS firewall side).
set -euo pipefail

APP_DIR="$HOME/blink-server"
NODE_MAJOR=24

echo "==> 1/6  System packages"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates gnupg

echo "==> 2/6  Node.js ${NODE_MAJOR} (NodeSource, arm64)"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> 3/6  Caddy (reverse proxy + auto-TLS)"
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y caddy
fi

echo "==> 4/6  Build the app"
cd "$APP_DIR"
[ -f .env ] || { echo "ERROR: $APP_DIR/.env missing — create it first."; exit 1; }
npm ci
npm run build   # -> dist/index.js (esbuild bundle)

echo "==> 5/6  Open OS firewall for HTTP/HTTPS"
# Oracle Ubuntu images ship strict iptables; allow 80/443 and persist.
sudo iptables -C INPUT -p tcp --dport 80  -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
sudo iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || (sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save)

echo "==> 6/6  systemd service + Caddy"
sudo cp deploy/oracle/blink-server.service /etc/systemd/system/blink-server.service
sudo cp deploy/oracle/Caddyfile /etc/caddy/Caddyfile
sudo systemctl daemon-reload
sudo systemctl enable --now blink-server
sudo systemctl reload caddy || sudo systemctl restart caddy

echo
echo "Done. Checks:"
echo "  sudo systemctl status blink-server --no-pager"
echo "  curl -s localhost:3001/health"
echo "  curl -s https://<your-domain>/health"
