# Personal VPS hosting (Seller Bunker)

Run Seller Bunker on one always-on VPS so your **phone bookmark keeps working**, orders sync, and the auto-repricer stays live — without a multi-service Render bill.

Stack files live under [`deploy/`](../deploy/):

| File | Purpose |
|------|---------|
| [`docker-compose.personal.yml`](../deploy/docker-compose.personal.yml) | Postgres + Redis + backend + frontend + Caddy |
| [`Caddyfile`](../deploy/Caddyfile) | HTTPS + route `/api*` → Nest (except Next webhook/checkout/contact) |
| [`.env.personal.example`](../deploy/.env.personal.example) | Secrets checklist (copy to `.env.personal`) |
| [`scripts/bootstrap-vps.sh`](../deploy/scripts/bootstrap-vps.sh) | Docker, UFW, unattended-upgrades |
| [`scripts/restore-db.sh`](../deploy/scripts/restore-db.sh) | Load a Render `pg_dump` |
| [`scripts/backup-db.sh`](../deploy/scripts/backup-db.sh) | Nightly DB dump |
| [`scripts/update-app.sh`](../deploy/scripts/update-app.sh) | `git pull` + rebuild |

---

## 0. Before you touch DNS or Render

1. **Dump production Postgres** (from a machine that can reach Render External DB URL):

   ```bash
   pg_dump "$RENDER_DATABASE_URL" -Fc -f sellerbunker-$(date +%Y%m%d).dump
   ```

   On Windows PowerShell (with `pg_dump` installed):

   ```powershell
   pg_dump $env:RENDER_DATABASE_URL -Fc -f "sellerbunker-$(Get-Date -Format yyyyMMdd).dump"
   ```

2. Copy **all** backend/frontend env vars from the Render dashboard into a local notes file (Clerk, LWA, AWS, JWT, Amazon app id, etc.).

3. Keep Render **running** until the VPS phone smoke-test passes.

---

## 1. Create the Hetzner VPS

1. Sign up / log in at [Hetzner Cloud](https://console.hetzner.cloud/).
2. Create a project → **Add Server**:
   - **Location:** Falkenstein or Nuremberg (EU) is fine.
   - **Image:** Ubuntu 24.04.
   - **Type:** CX22 (or similar: ~2 vCPU / 4 GB RAM).
   - **SSH key:** add your public key (do not rely on password-only).
3. Note the **public IPv4** (and IPv6 if shown).

---

## 2. Bootstrap the OS

From your PC:

```bash
ssh root@YOUR_VPS_IP
```

On the VPS:

```bash
# Get the repo (private: use a deploy key or personal access token)
mkdir -p /opt && cd /opt
git clone https://github.com/ethanc98/seller-dashboard.git
cd seller-dashboard
# Use the branch that has the deploy/ folder
git checkout startup-edits   # or main once merged

sudo bash deploy/scripts/bootstrap-vps.sh
# If you ran as root with a normal user later: log out/in so docker group applies
```

This installs Docker + Compose, opens **22/80/443** only, enables **unattended-upgrades** and fail2ban.

---

## 3. Configure env and start (before DNS flip is OK on IP, TLS needs DNS)

```bash
cd /opt/seller-dashboard
chmod +x deploy/scripts/*.sh
cp deploy/.env.personal.example deploy/.env.personal
nano deploy/.env.personal   # paste secrets from Render; set a strong POSTGRES_PASSWORD + JWT_SECRET
```

Important values for the **phone bookmark**:

- `SITE_ADDRESS=www.sellerbunker.com, sellerbunker.com` (or whatever host the bookmark opens)
- `FRONTEND_URL` / `NEXT_PUBLIC_*` = `https://www.sellerbunker.com` (same host)
- `AMAZON_REDIRECT_URI=https://www.sellerbunker.com/api/amazon/oauth/callback`
- `ENABLE_AMAZON_SYNC_SCHEDULER=true`
- `BYPASS_BILLING=true`

Upload the dump (from your PC):

```bash
scp sellerbunker-YYYYMMDD.dump root@YOUR_VPS_IP:/opt/seller-dashboard/
```

On the VPS:

```bash
cd /opt/seller-dashboard
# Start Postgres first, restore, then full stack
docker compose -f deploy/docker-compose.personal.yml --env-file deploy/.env.personal up -d postgres redis
bash deploy/scripts/restore-db.sh /opt/seller-dashboard/sellerbunker-YYYYMMDD.dump
docker compose -f deploy/docker-compose.personal.yml --env-file deploy/.env.personal up -d --build
```

Check logs:

```bash
docker compose -f deploy/docker-compose.personal.yml --env-file deploy/.env.personal logs -f --tail=100
```

---

## 4. Point DNS (keep the bookmark URL)

At your DNS provider (wherever `sellerbunker.com` is managed):

1. Lower TTL to 300 if possible.
2. Set **A** (and **AAAA** if you use IPv6) for `www` (and apex `@` if needed) to the **VPS IP**.
3. Remove or leave old Render CNAMEs only after cutover is confirmed.

Caddy will obtain Let’s Encrypt certs once DNS points here and ports 80/443 are open.

**Phone bookmark:** if it already opens `https://www.sellerbunker.com`, you do **not** need to re-add the icon after DNS propagates.

---

## 5. Post-cutover checks

1. Open the bookmark on your phone → sign in with Clerk.
2. Confirm recent orders / inventory look right.
3. Confirm backend logs show Amazon sync / repricer ticks (`ENABLE_*_SCHEDULER=true`).
4. In **Clerk**: allowed origins / redirect URLs include `https://www.sellerbunker.com`.
5. In **Amazon Developer / SP-API app**: login redirect URI matches `AMAZON_REDIRECT_URI` (only required if you re-link Amazon).

Optional nightly backup cron:

```bash
crontab -e
# 03:15 UTC daily
15 3 * * * /opt/seller-dashboard/deploy/scripts/backup-db.sh >> /var/log/sellerbunker-backup.log 2>&1
```

---

## 6. Ship app updates

On the VPS:

```bash
cd /opt/seller-dashboard
bash deploy/scripts/update-app.sh
# or a specific branch:
BRANCH=startup-edits bash deploy/scripts/update-app.sh
```

---

## 7. Shut down Render (only after phone works)

1. Suspend or delete **web** services (backend + frontend).
2. Suspend Redis if separate.
3. Keep **Postgres** 2–7 days as a safety net, then delete once backups on the VPS look good.
4. Cancel unused Render blueprints / test stacks.

---

## OS patching

- **Automatic:** `unattended-upgrades` installs security updates (enabled by `bootstrap-vps.sh`).
- **Monthly:** SSH in and run `sudo needrestart` (or reboot if a kernel update is pending):

  ```bash
  sudo apt update && sudo apt upgrade -y
  sudo needrestart
  # if kernel updated:
  sudo reboot
  ```

App code updates are separate (`update-app.sh`), not part of OS upgrades.

---

## Pairing checklist (do this with Cursor in chat)

When the VPS exists, send:

1. VPS IPv4 (and whether SSH as `root` works with your key).
2. Exact bookmark URL (e.g. `https://www.sellerbunker.com`).
3. Confirmation that `sellerbunker-YYYYMMDD.dump` is on the server or your PC.
4. Whether DNS is still on Render or already flipped.

Then walk through: bootstrap → `.env.personal` → restore → `up -d --build` → DNS → phone verify → Render suspend.

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| TLS / HTTPS fails | DNS A record → VPS; UFW allows 80/443; `docker compose ... logs caddy` |
| Blank API / 502 on `/api` | `logs backend`; `DATABASE_URL` / Postgres healthy |
| Clerk login loop | Publishable + secret keys; Clerk allowed origins |
| Amazon connect fails | `AMAZON_REDIRECT_URI` must match Amazon console exactly |
| Repricer silent | `ENABLE_REPRICER_SCHEDULER`; not `REPRICER_DRY_RUN` unless intentional |
| Out of disk | `deploy/backups` prune; `docker system df` |
