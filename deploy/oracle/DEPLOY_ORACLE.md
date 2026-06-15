# Deploying blink-server to an Oracle Cloud "Always Free" VM

A single always-on Ubuntu ARM VM running the Node server under systemd, behind
Caddy (auto-HTTPS). This fixes the two failures we hit on cPanel/Passenger:
**idle spin-down** (broke the cron) and **shared-host memory exhaustion** (the
"queue full" page). Here the process stays resident and owns its 12 GB.

## 1. Create the instance (web console — manual, one time)

1. Sign up at <https://cloud.oracle.com> (needs a card for identity; Always Free
   resources are never charged). Pick a **home region** close to your users —
   it can't be changed later, and Always Free lives only in the home region.
2. **Compute → Instances → Create instance**:
   - **Image**: Canonical Ubuntu 24.04 (or 22.04).
   - **Shape**: change to **Ampere (ARM) → VM.Standard.A1.Flex**, set
     **2 OCPU / 12 GB** (the current Always-Free max as of 2026-06-15).
     *If you get "out of capacity", try a different availability domain or
     region, or retry later — A1 capacity is the usual signup snag.*
   - **SSH keys**: upload your public key (`~/.ssh/id_ed25519.pub`) so you can
     `ssh ubuntu@<public-ip>`.
   - **Networking**: keep "assign public IPv4".
3. **Open ports in the OCI firewall** (VCN security list): Networking → your
   VCN → Security Lists → default → add **Ingress** rules:
   - `0.0.0.0/0` TCP **80**
   - `0.0.0.0/0` TCP **443**
   (Port 22 is open by default.)

When done you have: a public IP and `ssh ubuntu@<ip>` access. Hand that to me
and I take it from here — or do steps 2–4 below yourself.

## 2. Get the code + secrets onto the box

```bash
ssh ubuntu@<public-ip>
git clone https://github.com/Safwa9amar/blink-server.git ~/blink-server
# create the env file (KEY=VALUE per line, no quotes). Must include:
#   PORT=3001
#   ENABLE_INPROCESS_CRON=true     # always-on host -> in-process cron is fine
#   plus all SUPABASE_* / JWT_SECRET / CRON_SECRET / auth vars
nano ~/blink-server/.env
```

> **Cron note:** because this host never sleeps, set
> `ENABLE_INPROCESS_CRON=true`. The in-process node-cron (news +
> scheduled-notifications, every minute) runs reliably in the single resident
> process — no external crontab, no self-HTTP, none of the cPanel problems.

## 3. Point DNS at the VM

Add an **A record** for your domain (e.g. `blink.greenpedal.net`) → the VM's
public IP. Edit the domain in [`Caddyfile`](./Caddyfile) to match. Caddy will
fetch a Let's Encrypt cert automatically on first start.

## 4. Run setup — pick ONE path

### Option A — Docker Compose (recommended: portable, reproducible)

App + Caddy (auto-TLS) in one stack. Only Docker is needed on the host.

```bash
# install Docker once
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
# open the OS firewall for 80/443 (OCI Ubuntu ships strict iptables)
sudo iptables -I INPUT 6 -p tcp --dport 80  -j ACCEPT
sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save
# build + run
cd ~/blink-server && docker compose up -d --build
```

The same `docker compose up -d --build` runs this stack unchanged on any other
host later (Cloud Run, Koyeb, another VM) — that's the portability win.

### Option B — bare systemd + host Caddy

```bash
cd ~/blink-server && bash deploy/oracle/setup.sh
```

Installs Node 24 + Caddy, builds `dist/index.js`, opens the OS firewall,
installs the systemd service and Caddy config, and starts everything.

## Verify

```bash
curl -s localhost:3001/health            # {"status":"ok",...}
curl -s https://<your-domain>/health      # same, over TLS
# Docker:   docker compose ps && docker compose logs -f api
# systemd:  sudo systemctl status blink-server --no-pager
```

## Operate

```bash
# --- Docker ---
cd ~/blink-server && git pull && docker compose up -d --build   # redeploy
docker compose logs -f api                                       # logs
# --- systemd ---
cd ~/blink-server && git pull && npm ci && npm run build && sudo systemctl restart blink-server
journalctl -u blink-server -f
```
