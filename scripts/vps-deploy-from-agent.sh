#!/usr/bin/env bash
# Deploy current git HEAD to the personal Seller Bunker VPS (Cloud Agent / CI friendly).
#
# Required (Cloud Agents → Runtime Secrets):
#   VPS_SSH_PRIVATE_KEY  — full contents of ~/.ssh/sellerbunker-cursor-deploy
# Optional:
#   VPS_SSH_HOST         — default 91.98.135.161
#   VPS_SSH_USER         — default root
#   BRANCH               — default: current branch (else startup-edits)
#   SKIP_BUILD           — if set to 1, only sync git on the VPS (no docker rebuild)
#
# Usage (from repo root):
#   bash scripts/vps-deploy-from-agent.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

HOST="${VPS_SSH_HOST:-91.98.135.161}"
USER_NAME="${VPS_SSH_USER:-root}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo startup-edits)}"
if [[ -z "${BRANCH}" || "${BRANCH}" == "HEAD" ]]; then
  BRANCH="startup-edits"
fi

if [[ -z "${VPS_SSH_PRIVATE_KEY:-}" ]]; then
  # Local fallback: dedicated deploy key on disk
  LOCAL_KEY="${HOME}/.ssh/sellerbunker-cursor-deploy"
  if [[ -f "${LOCAL_KEY}" ]]; then
    export VPS_SSH_PRIVATE_KEY="$(cat "${LOCAL_KEY}")"
  else
    echo "Missing VPS_SSH_PRIVATE_KEY (and no ${LOCAL_KEY})." >&2
    echo "Add the private key as a Cloud Agents Runtime Secret, or generate the local key." >&2
    exit 1
  fi
fi

KEY_FILE="$(mktemp)"
cleanup() { rm -f "${KEY_FILE}" "${BUNDLE_FILE:-}"; }
trap cleanup EXIT

# Normalize Windows-style newlines if a secret was pasted from Notepad
printf '%s\n' "${VPS_SSH_PRIVATE_KEY}" | sed 's/\r$//' > "${KEY_FILE}"
chmod 600 "${KEY_FILE}"

SSH=(ssh -i "${KEY_FILE}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)
SCP=(scp -i "${KEY_FILE}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

echo "==> SSH smoke test (${USER_NAME}@${HOST})"
"${SSH[@]}" "${USER_NAME}@${HOST}" "hostname"

COMMIT="$(git rev-parse HEAD)"
echo "==> Bundling branch ${BRANCH} @ ${COMMIT}"
BUNDLE_FILE="$(mktemp --suffix=.bundle)"
git bundle create "${BUNDLE_FILE}" "${BRANCH}"

echo "==> Upload bundle → /root/seller-dashboard.bundle"
"${SCP[@]}" "${BUNDLE_FILE}" "${USER_NAME}@${HOST}:/root/seller-dashboard.bundle"

echo "==> Fetch + reset on VPS"
"${SSH[@]}" "${USER_NAME}@${HOST}" bash -s <<EOF
set -euo pipefail
cd /opt/seller-dashboard
git fetch origin
git checkout "${BRANCH}"
git reset --hard "origin/${BRANCH}"
git log -1 --oneline
EOF

if [[ "${SKIP_BUILD:-0}" == "1" ]]; then
  echo "==> SKIP_BUILD=1 — not running update-app.sh"
  exit 0
fi

echo "==> Rebuild stack (update-app.sh)"
"${SSH[@]}" "${USER_NAME}@${HOST}" bash -s <<EOF
set -euo pipefail
cd /opt/seller-dashboard
BRANCH="${BRANCH}" bash deploy/scripts/update-app.sh
EOF

echo "Deploy complete: ${BRANCH} @ ${COMMIT}"
