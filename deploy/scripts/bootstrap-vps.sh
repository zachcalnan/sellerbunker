#!/usr/bin/env bash
# Bootstrap an Ubuntu 24.04 VPS for Seller Bunker personal hosting.
# Run as root (or with sudo) once after creating the server:
#   curl -fsSL ... | bash
# or:
#   sudo bash deploy/scripts/bootstrap-vps.sh
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "==> OS packages + unattended security upgrades"
apt-get update -y
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  ufw \
  fail2ban \
  unattended-upgrades \
  apt-listchanges \
  needrestart \
  git

# Enable automatic security updates
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

# Prefer only security updates automatically; reboot manually when needed
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo "==> Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
  usermod -aG docker "${SUDO_USER}" || true
  echo "Added ${SUDO_USER} to docker group (log out/in for it to apply)."
fi

echo "==> Firewall (SSH + HTTP/HTTPS only)"
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

echo "==> fail2ban"
systemctl enable --now fail2ban

echo ""
echo "Bootstrap complete."
echo "Next:"
echo "  1. Clone the repo (or scp it) to e.g. /opt/seller-dashboard"
echo "  2. cp deploy/.env.personal.example deploy/.env.personal  # fill secrets"
echo "  3. docker compose -f deploy/docker-compose.personal.yml --env-file deploy/.env.personal up -d --build"
echo "  4. Restore DB: bash deploy/scripts/restore-db.sh /path/to/dump.dump"
echo "  5. Point DNS A/AAAA for www.sellerbunker.com at this VPS IP"
echo ""
echo "Monthly: check 'sudo needrestart' and reboot if a kernel update is pending."
